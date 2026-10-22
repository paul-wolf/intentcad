import { describe, it, expect, beforeEach, vi } from 'vitest';
import { machineProfileConfig } from '@/cam/machine';
import { createDefaultMachine } from '@/cam/setup';

const shop = { ...createDefaultMachine(), name: 'Shop router', defaultMaterial: 'carbon-fibre' as const };

vi.mock('@/api/camClient', () => ({
  camApi: {
    listProfiles: vi.fn(async () => [{ id: 'p-shop', name: 'Shop router' }, { id: 'p-old', name: 'Old router' }]),
    getProfile: vi.fn(async (id: string) => ({ id, name: 'Shop router', config: machineProfileConfig(shop) })),
    createJob: vi.fn(async () => ({ id: 'j-new' })),
    listJobs: vi.fn(async () => []),
  },
}));

const { useCamStore } = await import('./camStore');

describe('new jobs', () => {
  beforeEach(() => useCamStore.setState({ activeJobId: null, profiles: [] }));

  it('start on the machine saved most recently, in its default material', async () => {
    await useCamStore.getState().createJob('doc', 'Job 1');
    const s = useCamStore.getState();
    expect(s.job.setup.machineId).toBe('p-shop');
    expect(s.job.setup.material).toBe('carbon-fibre');
    expect(s.machine.name).toBe('Shop router');
  });

  it('start in birch ply on the built-in machine when there is no machine of your own', async () => {
    const { camApi } = await import('@/api/camClient');
    vi.mocked(camApi.listProfiles).mockResolvedValueOnce([]);
    await useCamStore.getState().createJob('doc', 'Job 1');
    const s = useCamStore.getState();
    expect(s.job.setup.machineId).toBeNull();
    expect(s.job.setup.material).toBe('birch-ply');
  });
});
