import { describe, expect, it } from 'vitest';
import { modelMenuLabel } from './codex-adapter';

describe('model menu parsing', () => {
  it('keeps model choices and removes reasoning controls', () => {
    expect(modelMenuLabel('5.6 Sol')).toBe('5.6 Sol');
    expect(modelMenuLabel('GPT-5.5')).toBe('GPT-5.5');
    expect(modelMenuLabel('高级')).toBeNull();
    expect(modelMenuLabel('极高')).toBeNull();
    expect(modelMenuLabel('最高')).toBeNull();
    expect(modelMenuLabel('Reasoning effort')).toBeNull();
    expect(modelMenuLabel('High')).toBeNull();
    expect(modelMenuLabel('xhigh')).toBeNull();
  });
});
