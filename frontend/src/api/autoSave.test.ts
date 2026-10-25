import { describe, expect, it, vi } from 'vitest';
import { getBackendId, setBackendId, subscribeBackendId } from './autoSave';

describe('subscribeBackendId', () => {
  it('tells listeners when the open document changes, until they unsubscribe', () => {
    const fn = vi.fn(() => getBackendId());
    const off = subscribeBackendId(fn);
    setBackendId('part-a');
    setBackendId('part-b');
    expect(fn.mock.results.map((r) => r.value)).toEqual(['part-a', 'part-b']);
    off();
    setBackendId(null);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(getBackendId()).toBeNull();
  });
});
