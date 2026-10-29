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
const getDocument = vi.fn();
vi.mock('./client', () => ({ api: { updateDocument: (...a: unknown[]) => updateDocument(...a),
                                    getDocument: (...a: unknown[]) => getDocument(...a) } }));
vi.mock('./syncEngine', () => ({ triggerSync: () => undefined }));

const { adoptCodeVersion, api, codeBaseOf, savedCodeOf } = await import('./cachedClient');

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

describe("updateDocument and this tab's script version", () => {
  const saved = (code: string, v: string) => ({ id: 'p', name: 'Plate', data: { modelCode: code }, project_id: null,
                                                updated_at: 'T1', code_version: v });
  beforeEach(() => {
    store.clear();
    updateDocument.mockReset();
    getDocument.mockReset();
    adoptCodeVersion('p', undefined);
    store.set('p', { id: 'p', name: 'Plate', data: {}, project_id: null, updated_at: 'T0', server_confirmed_updated_at: 'T0' });
  });

  it('sends the version it has as code_base, and has the new one once the server saved its script', async () => {
    adoptCodeVersion('p', 'v1');
    updateDocument.mockResolvedValueOnce(saved('b', 'v2'));
    await api.updateDocument('p', { data: { modelCode: 'b' } });
    expect(updateDocument.mock.calls[0]![1].code_base).toBe('v1');
    expect(codeBaseOf('p')).toBe('v2');
    expect(savedCodeOf('p')).toBe('b');
  });

  it('keeps its old version when the server kept a newer script (saved elsewhere) instead of this one', async () => {
    adoptCodeVersion('p', 'v1');
    updateDocument.mockResolvedValueOnce(saved('theirs', 'v3'));
    await api.updateDocument('p', { data: { modelCode: 'a' } });
    expect(codeBaseOf('p')).toBe('v1');
  });

  it('sends no code_base for an overwrite the user chose (null), or when it has no version', async () => {
    adoptCodeVersion('p', 'v1');
    updateDocument.mockResolvedValue(saved('b', 'v2'));
    await api.updateDocument('p', { data: { modelCode: 'b' } }, null);
    adoptCodeVersion('p', undefined);
    await api.updateDocument('p', { data: { modelCode: 'c' } });
    expect(updateDocument.mock.calls.map((c) => 'code_base' in c[1])).toEqual([false, false]);
  });

  it('a script changed elsewhere refuses the save: it throws a conflict that says so', async () => {
    updateDocument.mockRejectedValueOnce(Object.assign(new Error('API 409: changed'), { codeChanged: true }));
    getDocument.mockResolvedValueOnce(saved('theirs', 'v3'));
    adoptCodeVersion('p', 'v1', 'a');
    await expect(api.updateDocument('p', { data: { modelCode: 'mine' } })).rejects.toMatchObject({ conflict: true, codeChanged: true });
    expect(codeBaseOf('p')).toBe('v1');
    // the refused script is not the saved one: the tab can tell it is unsaved
    expect(savedCodeOf('p')).toBe('a');
  });
});
