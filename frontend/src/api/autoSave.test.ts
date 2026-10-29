import { describe, expect, it, vi } from 'vitest';
import { useDocumentStore } from '@/stores/documentStore';

const updateDocument = vi.fn();
vi.mock('./cachedClient', () => ({ api: { updateDocument: (...a: unknown[]) => updateDocument(...a) } }));

const { getBackendId, persistAiCode, setBackendId, subscribeBackendId } = await import('./autoSave');

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

describe('persistAiCode', () => {
  const start = () => {
    setBackendId('part-a');
    useDocumentStore.getState().setModelCode('mine', 'hand edit');
    updateDocument.mockReset();
  };

  it('saves the AI\'s script over the version it started from', async () => {
    start();
    updateDocument.mockImplementation(async (_id: string, p: { data: unknown }) => ({ data: p.data }));
    expect(await persistAiCode('ai', 'v1')).toEqual({ saved: true });
    expect(updateDocument.mock.calls[0]![2]).toBe('v1');
    expect(useDocumentStore.getState().document.modelCode).toBe('ai');
  });

  it('refused (the script changed in another tab or browser), this tab keeps its own script', async () => {
    start();
    const before = useDocumentStore.getState().document.modelCodeHistory;
    updateDocument.mockRejectedValueOnce(Object.assign(new Error('conflict'), { conflict: true, codeChanged: true }));
    expect(await persistAiCode('ai', 'v1')).toEqual({ saved: false, conflict: true, codeChanged: true });
    const doc = useDocumentStore.getState().document;
    expect([doc.modelCode, doc.modelCodeLabel, doc.modelCodeHistory]).toEqual(['mine', 'hand edit', before]);
    setBackendId(null);
  });
});
