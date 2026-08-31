import { describe, expect, it } from 'vitest';
import { normalizeDesktopModelId } from './codex-desktop-service';

describe('desktop model IDs', () => {
  it('normalizes display labels to stable Codex model IDs', () => {
    expect(normalizeDesktopModelId('5.6 Sol')).toBe('gpt-5.6-sol');
    expect(normalizeDesktopModelId('5.6 Terra')).toBe('gpt-5.6-terra');
    expect(normalizeDesktopModelId('GPT-5.5')).toBe('gpt-5.5');
    expect(normalizeDesktopModelId('custom-model')).toBe('custom-model');
  });
});
