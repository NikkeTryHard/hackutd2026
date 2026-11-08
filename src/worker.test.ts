import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import type { Page } from 'playwright';
import type { Action } from './contracts';
import { pngDimensions } from './model';
import {
  ProfileViolationError,
  cropObservation,
  executeAction,
  mapObservationPoint,
  replicaRequestAllowed,
} from './worker';

const REPLICA = 'http://127.0.0.1:4311';

function rule(url: string, agentId = 'agent-a', scenario: 'shop' | 'portal' = 'shop') {
  return replicaRequestAllowed(new URL(url), REPLICA, agentId, { scenario });
}

describe('replica containment rules', () => {
  test('allows only this agent own scenario document and world API', () => {
    expect(rule(`${REPLICA}/shop?agent=agent-a`).ok).toBe(true);
    expect(rule(`${REPLICA}/api/world/agent-a`).ok).toBe(true);
    expect(rule(`${REPLICA}/api/world/agent-a/action`).ok).toBe(true);
    expect(rule(`${REPLICA}/api/world/agent-a/ack`).ok).toBe(true);
  });

  test('blocks other agents, other scenarios, dashboard and file access', () => {
    expect(rule(`${REPLICA}/shop?agent=agent-b`).ok).toBe(false);
    expect(rule(`${REPLICA}/shop`).ok).toBe(false);
    expect(rule(`${REPLICA}/shop?agent=agent-a&agentId=agent-b`).ok).toBe(false);
    expect(rule(`${REPLICA}/shop?agent=agent-a&extra=1`).ok).toBe(false);
    expect(rule(`${REPLICA}/portal?agent=agent-a`).ok).toBe(false);
    expect(rule(`${REPLICA}/api/world/agent-b`).ok).toBe(false);
    expect(rule(`${REPLICA}/api/world/agent-b/action`).ok).toBe(false);
    expect(rule(`${REPLICA}/api/health`).ok).toBe(false);
    expect(rule(`${REPLICA}/artifacts/leak.png`).ok).toBe(false);
    expect(rule(`${REPLICA}/report/agent-a`).ok).toBe(false);
    expect(rule(`${REPLICA}/`).ok).toBe(false);
    expect(rule('http://127.0.0.1:4310/api/runs').ok).toBe(false);
    expect(rule('https://example.com/shop?agent=agent-a').ok).toBe(false);
    expect(rule('file:///etc/passwd').ok).toBe(false);
  });

  test('allows inline data/blob and only own-world WebSocket paths', () => {
    expect(rule('data:image/png;base64,AAAA').ok).toBe(true);
    expect(rule('blob:http://127.0.0.1:4311/1234').ok).toBe(true);
    expect(
      replicaRequestAllowed(new URL('ws://127.0.0.1:4311/api/world/agent-a'), REPLICA, 'agent-a', {
        scenario: 'shop',
        websocket: true,
      }).ok,
    ).toBe(true);
    expect(
      replicaRequestAllowed(new URL('wss://127.0.0.1:4311/api/world/agent-a'), REPLICA, 'agent-a', {
        scenario: 'shop',
        websocket: true,
      }).ok,
    ).toBe(false);
    expect(
      replicaRequestAllowed(new URL('ws://example.com/api/world/agent-a'), REPLICA, 'agent-a', {
        scenario: 'shop',
        websocket: true,
      }).ok,
    ).toBe(false);
    expect(
      replicaRequestAllowed(new URL('ws://127.0.0.1:4311/shop?agent=agent-a'), REPLICA, 'agent-a', {
        scenario: 'shop',
        websocket: true,
      }).ok,
    ).toBe(false);
    expect(
      replicaRequestAllowed(new URL('ws://127.0.0.1:4311/api/world/agent-b'), REPLICA, 'agent-a', {
        scenario: 'shop',
        websocket: true,
      }).ok,
    ).toBe(false);
  });
});

describe('observation coordinate mapping', () => {
  test('maps full-viewport coordinates identically', () => {
    const full = { originX: 0, originY: 0, scale: 1, width: 1280, height: 800 };
    expect(mapObservationPoint(full, { x: 100, y: 200 })).toEqual({ x: 100, y: 200 });
  });

  test('maps crop-image coordinates back through origin and scale', () => {
    const crop = { originX: 100, originY: 50, scale: 2, width: 400, height: 300 };
    expect(mapObservationPoint(crop, { x: 10, y: 20 })).toEqual({ x: 105, y: 60 });
    expect(() => mapObservationPoint(crop, { x: 400, y: 0 })).toThrow();
    expect(() => mapObservationPoint(crop, { x: 0, y: 300 })).toThrow();
  });

  test('maps nested crop views and rejects mapped offscreen points', () => {
    const nested = { originX: 150, originY: 75, scale: 4, width: 400, height: 200 };
    expect(mapObservationPoint(nested, { x: 40, y: 20 })).toEqual({ x: 160, y: 80 });
    const edge = { originX: 1270, originY: 0, scale: 1, width: 20, height: 800 };
    expect(() => mapObservationPoint(edge, { x: 15, y: 0 })).toThrow();
  });
});

describe('cropObservation', () => {
  test('extracts and scales a bounded crop with origin metadata', async () => {
    const source = await sharp({
      create: { width: 100, height: 80, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const result = await cropObservation(new Uint8Array(source), {
      type: 'crop',
      x: 10,
      y: 20,
      width: 40,
      height: 30,
      scale: 2,
    });
    expect(result.source).toEqual({ x: 10, y: 20, width: 40, height: 30 });
    expect(result.scale).toBe(2);
    expect(result.image).toEqual({ width: 80, height: 60 });
    expect(pngDimensions(result.bytes)).toEqual({ width: 80, height: 60 });
  });

  test('rejects crops outside the observation and oversized output', async () => {
    const source = await sharp({
      create: { width: 100, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    await expect(
      cropObservation(new Uint8Array(source), {
        type: 'crop',
        x: 80,
        y: 0,
        width: 40,
        height: 20,
        scale: 1,
      }),
    ).rejects.toThrow();

    const large = await sharp({
      create: { width: 500, height: 500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    await expect(
      cropObservation(new Uint8Array(large), {
        type: 'crop',
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        scale: 4,
      }),
    ).rejects.toThrow();
    await expect(
      cropObservation(new Uint8Array([1, 2, 3, 4]), {
        type: 'crop',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        scale: 1,
      }),
    ).rejects.toThrow();
  });
});

describe('executor profile enforcement', () => {
  test('keyboard profile rejects every pointer action before touching the page', async () => {
    const unusedPage = {} as Page;
    const pointerActions: Action[] = [
      { type: 'click', x: 10, y: 20 },
      { type: 'move', x: 10, y: 20 },
      { type: 'drag', x: 10, y: 20, toX: 30, toY: 40 },
      { type: 'scroll', dx: 0, dy: 120 },
    ];
    for (const action of pointerActions) {
      await expect(executeAction(unusedPage, action, 'keyboard', 1)).rejects.toBeInstanceOf(
        ProfileViolationError,
      );
    }
  });
});
