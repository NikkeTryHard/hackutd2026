import type { Profile } from './contracts';

/**
 * Canonical interaction-profile registry.
 *
 * Profile IDs are persisted in the SpacetimeDB run row and accepted by the HTTP
 * API, so they are a storage contract. Labels, dashboard descriptions and model
 * guidance live here so the dashboard, backend parser, model prompt and browser
 * worker cannot drift.
 *
 * The age profiles are hypothetical test personas for exercising a replica.
 * They are not validated demographic simulations and say nothing about a
 * person's physical, sensory or cognitive ability.
 */

export type VisionDeficiency = 'deuteranopia' | 'protanopia' | 'tritanopia' | 'achromatopsia';

export interface ProfileDefinition {
  readonly label: string;
  readonly description: string;
  /** Rule text supplied verbatim to the screenshot-only model. */
  readonly guidance: string;
  /** Exact Chromium Emulation.setEmulatedVisionDeficiency mode, when any. */
  readonly visionDeficiency?: VisionDeficiency;
}

export const PROFILE_IDS = [
  'baseline',
  'keyboard',
  'pointer',
  'older-adult',
  'child',
  'young-adult',
  'deuteranopia',
  'protanopia',
  'tritanopia',
  'achromatopsia',
] as const satisfies readonly Profile[];

/** Representative set launched when the caller does not name profiles. */
export const DEFAULT_PROFILE_SELECTION = [
  'baseline',
  'older-adult',
  'child',
  'young-adult',
  'deuteranopia',
] as const satisfies readonly Profile[];

/**
 * Capacity needed to launch every selectable profile in one batch. The server
 * and dashboard share this value; there is no launch queue.
 */
export const MAX_CONCURRENT_AGENTS = PROFILE_IDS.length;

function visionGuidance(mode: VisionDeficiency, detail: string): string {
  return `The browser renders with Chromium Emulation.setEmulatedVisionDeficiency mode=${mode} (${detail}). Interpret colors accordingly; rely on labels, shapes and positions. Pointer and keyboard actions are allowed.`;
}

export const PROFILE_DEFINITIONS: Record<Profile, ProfileDefinition> = {
  baseline: {
    label: 'Baseline',
    description: 'Full pointer and keyboard interaction with no added constraints.',
    guidance: 'Standard browser interaction. Pointer and keyboard actions are allowed.',
  },
  keyboard: {
    label: 'Keyboard only',
    description: 'Pointer actions are rejected; the agent must navigate with the keyboard.',
    guidance:
      'Keyboard-only. Pointer actions (click, move, drag, scroll) are rejected by the executor. Use Tab, Shift+Tab, Enter, Space, arrow keys and other key actions; use type only for text fields.',
  },
  pointer: {
    label: 'Synthetic pointer imprecision',
    description:
      'Deterministic seeded coordinate offset. This is synthetic stress, not a motor-disability simulation.',
    guidance:
      'Synthetic pointer imprecision is applied to pointer coordinates with a deterministic seed. Aim at the center of a target and expect a small logged offset between intended and executed coordinates. This is synthetic stress, not a motor-disability simulation.',
  },
  'older-adult': {
    label: 'Older adult persona',
    description:
      'Hypothetical older-adult test persona: cautious, explicit-label navigation with confirmation before committing. Not a demographic simulation.',
    guidance:
      'Hypothetical older-adult test persona, not a demographic simulation and not a statement about physical or cognitive ability. Navigate cautiously: prefer controls with explicit visible text labels over icon-only controls or guessed positions, re-read the visible screen before each action, and before committing a state change (add to cart, checkout, submit) confirm the visible item, variant, quantity, price and destination, then perform exactly one commit action. Pointer and keyboard actions are allowed.',
  },
  child: {
    label: 'Child persona',
    description:
      'Hypothetical first-time child test persona: plain-language navigation and no real personal or payment information. Not a demographic simulation.',
    guidance:
      'Hypothetical child test persona using the replica for the first time, not a demographic simulation and not a statement about physical or cognitive ability. Use plain-language visible labels, take one obvious step at a time, and avoid assuming prior product knowledge. Never enter real personal, contact or payment information: use clearly synthetic placeholder text when a field cannot be avoided, and stop and report if the task needs real identity or payment details. Pointer and keyboard actions are allowed.',
  },
  'young-adult': {
    label: 'Young adult persona',
    description:
      'Hypothetical young-adult test persona: task-focused scanning and concise, direct navigation. Not a demographic simulation.',
    guidance:
      'Hypothetical young-adult test persona, not a demographic simulation and not a statement about physical or cognitive ability. Work in a task-focused scanning style: read the current screenshot for the requested target, take the shortest visible path to it, and keep reasoning concise. Do not open unrelated panels or repeat already-completed steps. Pointer and keyboard actions are allowed.',
  },
  deuteranopia: {
    label: 'Deuteranopia rendering',
    description: 'Chromium emulates deuteranopia for rendered screenshots and observations.',
    guidance: visionGuidance('deuteranopia', 'red-green deficiency, green cone response absent'),
    visionDeficiency: 'deuteranopia',
  },
  protanopia: {
    label: 'Protanopia rendering',
    description: 'Chromium emulates protanopia for rendered screenshots and observations.',
    guidance: visionGuidance('protanopia', 'red-green deficiency, red cone response absent'),
    visionDeficiency: 'protanopia',
  },
  tritanopia: {
    label: 'Tritanopia rendering',
    description: 'Chromium emulates tritanopia for rendered screenshots and observations.',
    guidance: visionGuidance('tritanopia', 'blue-yellow deficiency, blue cone response absent'),
    visionDeficiency: 'tritanopia',
  },
  achromatopsia: {
    label: 'Achromatopsia rendering',
    description:
      'Chromium emulates achromatopsia (monochrome vision) for rendered screenshots and observations.',
    guidance: visionGuidance('achromatopsia', 'total color blindness, monochrome rendering'),
    visionDeficiency: 'achromatopsia',
  },
};

export function isProfile(value: unknown): value is Profile {
  return typeof value === 'string' && PROFILE_IDS.some((profile) => profile === value);
}
