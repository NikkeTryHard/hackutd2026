import { describe, expect, test } from 'bun:test';
import type { EvidenceEvent } from './contracts';
import {
  formatDeliveredMessages,
  historyTextForModel,
  modelHealth,
  normalizeKeyCombo,
  pngDimensions,
  validateAction,
  validateDecision,
} from './model';

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

function event(
  partial: Partial<EvidenceEvent> & Pick<EvidenceEvent, 'kind' | 'text' | 'seq'>,
): EvidenceEvent {
  return {
    id: `event-${partial.seq}`,
    agentId: 'agent',
    at: partial.seq,
    ...partial,
  };
}

describe('validateAction strict bounds', () => {
  test('accepts fractional coordinates strictly inside the viewport', () => {
    expect(validateAction({ type: 'click', x: 1279.999, y: 799.999 })).toEqual({
      type: 'click',
      x: 1279.999,
      y: 799.999,
    });
  });

  test('rejects coordinates exactly at width or height', () => {
    expect(() => validateAction({ type: 'click', x: 1280, y: 0 })).toThrow();
    expect(() => validateAction({ type: 'click', x: 0, y: 800 })).toThrow();
    expect(() => validateAction({ type: 'move', x: -0.001, y: 0 })).toThrow();
    expect(() => validateAction({ type: 'drag', x: 1, y: 2, toX: 1280, toY: 3 })).toThrow();
    expect(() => validateAction({ type: 'drag', x: 1, y: 2, toX: 3, toY: 800 })).toThrow();
  });

  test('uses the current observation dimensions for crop-image coordinates', () => {
    const view = { width: 400, height: 300 };
    expect(validateAction({ type: 'click', x: 399.5, y: 299.5 }, { view })).toEqual({
      type: 'click',
      x: 399.5,
      y: 299.5,
    });
    expect(() => validateAction({ type: 'click', x: 400, y: 0 }, { view })).toThrow();
    expect(() => validateAction({ type: 'click', x: 0, y: 300 }, { view })).toThrow();
  });

  test('rejects unknown fields and malformed primitives', () => {
    expect(() => validateAction({ type: 'click', x: 1, y: 2, selector: '#button' })).toThrow();
    expect(() => validateAction({ type: 'click', x: Number.NaN, y: 2 })).toThrow();
    expect(() => validateAction({ type: 'scroll', dx: 0, dy: 0 })).toThrow();
    expect(() => validateAction({ type: 'wait', ms: 0 })).toThrow();
    expect(() => validateAction({ type: 'wait', ms: 10_001 })).toThrow();
    expect(() => validateAction({ type: 'type', text: 'bad\u0000text' })).toThrow();
    expect(() => validateAction({ type: 'type', text: 'x'.repeat(501) })).toThrow();
  });

  test('bounds crops to the observation and the 1280x800 output cap', () => {
    expect(() =>
      validateAction({ type: 'crop', x: 1000, y: 0, width: 400, height: 100, scale: 1 }),
    ).toThrow();
    expect(() =>
      validateAction({ type: 'crop', x: 0, y: 0, width: 400, height: 400, scale: 4 }),
    ).toThrow();
    expect(validateAction({ type: 'crop', x: 10, y: 10, width: 40, height: 30, scale: 2 })).toEqual(
      { type: 'crop', x: 10, y: 10, width: 40, height: 30, scale: 2 },
    );
  });

  test('validates report and finish payloads', () => {
    expect(
      validateAction({
        type: 'report',
        title: 'Broken stock notice',
        detail: 'The notice remains stale after the scheduled change.',
        severity: 'major',
      }),
    ).toMatchObject({ type: 'report', severity: 'major' });
    expect(() =>
      validateAction({ type: 'report', title: 'x', detail: 'y', severity: 'severe' }),
    ).toThrow();
    expect(validateAction({ type: 'finish', summary: 'Checkout completed' })).toEqual({
      type: 'finish',
      summary: 'Checkout completed',
    });
  });
});

describe('decision envelope', () => {
  test('rejects extra fields and invalid actions', () => {
    expect(() =>
      validateDecision({ action: { type: 'click', x: 1, y: 2 }, reasoning: 'ok', extra: true }),
    ).toThrow();
    expect(() => validateDecision({ action: { type: 'click', x: 1, y: 2 } })).toThrow();
    expect(() =>
      validateDecision({ action: { type: 'click', x: 1280, y: 0 }, reasoning: 'edge' }),
    ).toThrow();
    expect(validateDecision({ action: { type: 'observe' }, reasoning: 'look again' })).toEqual({
      action: { type: 'observe' },
      reasoning: 'look again',
    });
  });
});

describe('key normalization', () => {
  test('canonicalizes modifiers and named keys', () => {
    expect(normalizeKeyCombo('Shift+Tab')).toBe('Shift+Tab');
    expect(normalizeKeyCombo('ctrl+enter')).toBe('Control+Enter');
    expect(normalizeKeyCombo('A')).toBe('A');
  });

  test('rejects unknown keys and duplicate modifiers', () => {
    expect(() => normalizeKeyCombo('Hyper+X')).toThrow();
    expect(() => normalizeKeyCombo('Shift+Shift+Tab')).toThrow();
    expect(() => normalizeKeyCombo('Shift')).toThrow();
    expect(() => normalizeKeyCombo('')).toThrow();
  });
});

describe('agent-visible history sanitization', () => {
  test('keeps the newest history lines when the character budget is tight', () => {
    const events = Array.from({ length: 16 }, (_, index) =>
      event({
        seq: index + 1,
        kind: 'action',
        text: `event-${String(index + 1).padStart(2, '0')} ${'x'.repeat(300)}`,
      }),
    );
    const text = historyTextForModel(events);
    expect(text).toContain('event-16');
    expect(text).not.toContain('event-01');
  });

  test('keeps the newest operator messages when the character budget is tight', () => {
    const messages = Array.from(
      { length: 6 },
      (_, index) => `message-${index + 1}-${'y'.repeat(480)}`,
    );
    const text = formatDeliveredMessages(messages);
    expect(text).toContain('message-6');
    expect(text).not.toContain('message-1-');
    expect(text.indexOf('message-5')).toBeLessThan(text.indexOf('message-6'));
  });

  test('never serializes world data, artifact paths or unsafe error text', () => {
    const events: EvidenceEvent[] = [
      event({
        seq: 1,
        kind: 'world',
        text: 'World transition: defect=true; notice=HIDDEN',
        data: { defect: true, notice: 'HIDDEN', panels: ['secret panel'] },
      }),
      event({
        seq: 2,
        kind: 'observation',
        text: 'artifact /artifacts/hidden-crop.png',
        artifact: '/artifacts/hidden-crop.png',
        data: { crop: { x: 1, y: 2 }, sha256: 'secret-hash' },
      }),
      event({
        seq: 3,
        kind: 'action',
        text: 'click input (10, 20) → viewport (10, 20)',
        data: { reasoning: 'raw reasoning' },
      }),
      event({
        seq: 4,
        kind: 'error',
        text: 'backend ground-truth leak',
        data: { category: 'scenario' },
      }),
      event({
        seq: 5,
        kind: 'error',
        text: 'Keyboard-only profile rejected pointer action "click" at step 2.',
        data: { category: 'profile' },
      }),
    ];
    const text = historyTextForModel(events);
    expect(text).not.toContain('HIDDEN');
    expect(text).not.toContain('defect');
    expect(text).not.toContain('hidden-crop');
    expect(text).not.toContain('secret-hash');
    expect(text).not.toContain('backend ground-truth leak');
    expect(text).toContain('World state changed');
    expect(text).toContain('Observation captured');
    expect(text).toContain('Keyboard-only profile rejected');
    expect(text).toContain('click input (10, 20)');
  });
});

describe('PNG and model configuration', () => {
  test('reads dimensions and rejects non-PNG bytes', () => {
    expect(pngDimensions(PNG_1X1)).toEqual({ width: 1, height: 1 });
    expect(() => pngDimensions(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });

  test('missing model environment fails explicitly without a network call', async () => {
    const keys = ['MODEL_BASE_URL', 'MODEL_ID', 'MODEL_API_KEY'] as const;
    const saved = keys.map((key) => [key, process.env[key]] as const);
    for (const key of keys) delete process.env[key];
    try {
      const health = await modelHealth();
      expect(health.ok).toBe(false);
      expect(health.detail).toContain('MODEL_BASE_URL');
      expect(health.detail).toContain('MODEL_ID');
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
