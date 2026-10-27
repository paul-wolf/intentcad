import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import type { ChatMessage } from '@/types/document';
import { cardActionState, cardKey, runCardAction, withCardStatus } from './cardAction';
import { acceptParameters } from './ParameterProposalCard';
import { acceptBrief } from './ProjectChat';

let n = 0;
const key = () => cardKey('doc', 'params', ++n);
const refused = () => new ApiError(409, JSON.stringify({ message: 'This was changed elsewhere.' }));

afterEach(() => { vi.useRealTimers(); });

describe('a card action', () => {
  it('shows a failed accept as an error, with the button free to try again', async () => {
    const k = key();
    await runCardAction(k, () => Promise.reject(new Error('Network down')));
    expect(cardActionState(k)).toEqual({ busy: false, error: 'Network down', note: '' });
    await runCardAction(k, async () => 'Saved, but one sketch can\'t be solved');
    expect(cardActionState(k)).toEqual({ busy: false, error: '', note: 'Saved, but one sketch can\'t be solved' });
  });

  it('runs a refused (409) accept once more, reading the state again', async () => {
    const k = key();
    const action = vi.fn().mockRejectedValueOnce(refused()).mockResolvedValueOnce(undefined);
    await runCardAction(k, action);
    expect(action).toHaveBeenCalledTimes(2);
    expect(cardActionState(k)).toEqual({ busy: false, error: '', note: '' });
  });

  it('says so when it is refused twice, and is free again', async () => {
    const k = key();
    const action = vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { conflict: true }));
    await runCardAction(k, action);
    expect(action).toHaveBeenCalledTimes(2);
    expect(cardActionState(k).busy).toBe(false);
    expect(cardActionState(k).error).toMatch(/changed elsewhere/);
  });

  it('keeps a pending save across a card drawn again: still busy, no second save, then the result', async () => {
    const k = key();
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const first = runCardAction(k, action);
    // the chat re-renders: a new card reads the same state, and a click on it does nothing yet
    expect(cardActionState(k).busy).toBe(true);
    await runCardAction(k, action);
    expect(action).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(cardActionState(k)).toEqual({ busy: false, error: '', note: '' });
  });

  it('stops waiting when the server never answers, and a late answer does not undo a newer try', async () => {
    vi.useFakeTimers();
    const k = key();
    let late!: (v: string) => void;
    const stuck = runCardAction(k, () => new Promise<string>((r) => { late = r; }), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await stuck;
    expect(cardActionState(k).busy).toBe(false);
    expect(cardActionState(k).error).toMatch(/No answer from the server/);
    await runCardAction(k, () => Promise.reject(new Error('second try failed')));
    late('first try');
    await vi.advanceTimersByTimeAsync(0);
    expect(cardActionState(k).error).toBe('second try failed');
  });
});

describe('a card status write', () => {
  const card = (at: number): ChatMessage => ({ role: 'assistant', text: '', at,
    params: { items: [{ name: 'bed', value: 220, unit: 'mm', reason: '' }], status: 'pending' } });

  it('lands on its own message in the chat as it is now', () => {
    // accepted while the chat moved on: another card was rejected, a new message came in
    const now: ChatMessage[] = [card(1), withCardStatus([card(2)], 2, 'params', 'rejected')[0]!,
                                { role: 'user', text: 'and the arms?', at: 3 }, card(4)];
    const after = withCardStatus(now, 1, 'params', 'accepted');
    expect(after.map((m) => m.params?.status ?? m.text)).toEqual(['accepted', 'rejected', 'and the arms?', 'pending']);
  });

  it('can carry more of the message (applied held code keeps its code)', () => {
    const held: ChatMessage = { role: 'assistant', text: '', at: 5, held: { code: 'x = 1', label: '', broken: [], status: 'pending' } };
    expect(withCardStatus([held], 5, 'held', 'applied', { code: 'x = 1' })[0]).toMatchObject({ code: 'x = 1', held: { status: 'applied' } });
    expect(withCardStatus([held], 6, 'held', 'applied')[0]).toBe(held);
  });
});

describe('accepting proposed parameters', () => {
  it('merges into the newer parameters when the first save was refused', async () => {
    const k = key();
    const read = vi.fn()
      .mockResolvedValueOnce({ parameters: [{ name: 'arm', value: 30, unit: 'mm' }] })
      .mockResolvedValueOnce({ parameters: [{ name: 'arm', value: 32, unit: 'mm' }, { name: 'hub', value: 60, unit: 'mm' }] });
    // projectClient's own error for a refused save
    const save = vi.fn().mockRejectedValueOnce(new Error('API 409: {"message":"changed"}')).mockResolvedValueOnce({ failed: [], errors: [] });
    const done = vi.fn();
    await runCardAction(k, () => acceptParameters('p1', [{ name: 'bed', value: 220, unit: 'mm' }], done, save as never, read as never));
    expect(save).toHaveBeenLastCalledWith('p1', [
      { name: 'arm', value: 32, unit: 'mm' }, { name: 'hub', value: 60, unit: 'mm' }, { name: 'bed', value: 220, unit: 'mm' }]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(cardActionState(k)).toEqual({ busy: false, error: '', note: '' });
  });

  it('says what failed and leaves the card pending', async () => {
    const k = key();
    const done = vi.fn();
    const save = vi.fn().mockRejectedValue(new ApiError(500, JSON.stringify({ message: 'Server error' })));
    await runCardAction(k, () => acceptParameters('p1', [], done, save as never, (async () => ({ parameters: [] })) as never));
    expect(done).not.toHaveBeenCalled();
    expect(cardActionState(k)).toMatchObject({ busy: false, error: 'Server error' });
  });

  it('says why outside a project instead of a dead button', async () => {
    const k = key();
    await runCardAction(k, () => acceptParameters(null, [], () => {}));
    expect(cardActionState(k).error).toMatch(/isn't in a project/);
  });

  it('notes the sketches that could not be solved, as saved', async () => {
    const r = await acceptParameters('p1', [], () => {}, (async () => ({ failed: ['Frame: overconstrained'], errors: [] })) as never,
                                     (async () => ({ parameters: [] })) as never);
    expect(r).toBe("Saved, but can't be solved: Frame: overconstrained");
  });
});

describe('accepting a brief change', () => {
  const brief = { text: 'new', reason: 'tidy', base: 'old', status: 'pending' as const };

  it('shows the brief as it is now when it changed since the AI read it, and saves once that was seen', async () => {
    const save = vi.fn().mockResolvedValue({});
    const read = (async () => ({ brief: 'edited by hand' })) as never;
    expect(await acceptBrief('p1', brief, null, read, save)).toEqual({ changed: 'edited by hand' });
    expect(save).not.toHaveBeenCalled();
    expect(await acceptBrief('p1', brief, 'edited by hand', read, save)).toBe('saved');
    expect(save).toHaveBeenCalledWith('p1', 'new', 'AI proposal: tidy');
  });

  it('is done when the brief already says it (an accept that landed before a reload)', async () => {
    const save = vi.fn();
    expect(await acceptBrief('p1', brief, null, (async () => ({ brief: 'new' })) as never, save)).toBe('saved');
    expect(save).not.toHaveBeenCalled();
  });
});
