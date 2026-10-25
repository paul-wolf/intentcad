import { describe, expect, it } from 'vitest';
import { wantsNewTab } from './links';

const click = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }> = {}) =>
  ({ metaKey: false, ctrlKey: false, shiftKey: false, button: 0, ...o });

describe('wantsNewTab', () => {
  it('is false for a plain left click', () => expect(wantsNewTab(click())).toBe(false));
  it('is true with Cmd, Ctrl or Shift held', () => {
    expect(wantsNewTab(click({ metaKey: true }))).toBe(true);
    expect(wantsNewTab(click({ ctrlKey: true }))).toBe(true);
    expect(wantsNewTab(click({ shiftKey: true }))).toBe(true);
  });
  it('is true for the middle button', () => expect(wantsNewTab(click({ button: 1 }))).toBe(true));
});
