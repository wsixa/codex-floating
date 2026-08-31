import { describe, expect, it } from 'vitest';
import { OFFICIAL_PAGE_COMPACT_SCRIPT } from './official-page-host';

describe('official page compact injection', () => {
  it('hides surrounding chrome while keeping the official composer visible', () => {
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).toContain('data-app-action-sidebar');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).toContain('#app-shell-sidebar');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).toContain('data-app-shell-unified-tab-strip');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).toContain('right-panel');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).toContain('[data-codex-composer]');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).not.toMatch(/data-codex-composer[^']*display:\s*none/i);
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).not.toContain('[role="banner"]');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).not.toContain('[data-testid*="header"');
    expect(OFFICIAL_PAGE_COMPACT_SCRIPT).not.toContain('[data-testid*="sidebar"');
  });
});
