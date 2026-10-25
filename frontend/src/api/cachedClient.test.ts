import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, Record<string, unknown>>();
vi.mock('./db', () => ({
  db: {
    documents: {
      get: async (id: string) => store.get(id),
      put: async (doc: Record<string, unknown>) => { store.set(doc.id as string, doc); },
    },
    syncQueue: { where: () => ({ equals: () => ({ delete: async () => 0 }) }) },
  },
}));
const updateDocument = vi.fn();
vi.mock('./client', () => ({ api: { updateDocument: (...a: unknown[]) => updateDocument(...a) } }));
vi.mock('./syncEngine', () => ({ triggerSync: () => undefined }));

const { api } = await import('./cachedClient');

describe('updateDocument', () => {
  beforeEach(() => {
    store.clear();
    updateDocument.mockReset();
    store.set('p', { id: 'p', name: 'Plate', data: {}, project_id: null,
                     updated_at: 'T0', server_confirmed_updated_at: 'T0' });
  });

  it('sends overlapping saves one at a time, each from the version the last one got back', async () => {
    let n = 0;
    updateDocument.mockImplementation(async (id: string, payload: { name: string }) => {
      await new Promise((r) => setTimeout(r, 5));
      n += 1;
      return { id, name: payload.name, data: {}, project_id: null, updated_at: `T${n}` };
    });
    await Promise.all([api.updateDocument('p', { name: 'a' }), api.updateDocument('p', { name: 'b' })]);
    expect(updateDocument.mock.calls.map((c) => c[1].base_updated_at)).toEqual(['T0', 'T1']);
    expect(store.get('p')?.server_confirmed_updated_at).toBe('T2');
  });

  it('a failed save does not hold up the next one', async () => {
    updateDocument.mockRejectedValueOnce(new Error('API 422: bad'))
      .mockResolvedValueOnce({ id: 'p', name: 'b', data: {}, project_id: null, updated_at: 'T1' });
    const results = await Promise.allSettled([api.updateDocument('p', { name: 'a' }), api.updateDocument('p', { name: 'b' })]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    // the optimistic write of the failed save kept the last confirmed version as the base
    expect(updateDocument.mock.calls.map((c) => c[1].base_updated_at)).toEqual(['T0', 'T0']);
  });
});
