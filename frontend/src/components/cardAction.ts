/**
 * What an Accept (or Apply, or Make it) on a chat card is doing, kept outside
 * the card: a card the chat draws again (a new message, the chat folded and
 * opened, the context pane and back) still shows "Saving…", and then the
 * result, instead of a fresh Accept that sends it twice. Every run ends: done,
 * an error to show with Try again, or, if the server doesn't answer, an error
 * saying so. A save refused because something changed elsewhere (409) runs
 * once more, since each card's action reads the current state first.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, errorText } from '@/api/client';
import type { ChatMessage } from '@/types/document';

export interface CardActionState {
  busy: boolean;
  /** why the last run failed ('' when it didn't) */
  error: string;
  /** what the last run that went through said (e.g. "Saved, but …") */
  note: string;
}

const IDLE: CardActionState = { busy: false, error: '', note: '' };
const states = new Map<string, CardActionState>();
const runs = new Map<string, number>();
const listeners = new Set<() => void>();
let lastRun = 0;

/** How long a card waits for an answer before it says there was none. */
export const CARD_TIMEOUT_MS = 90_000;

function put(key: string, state: CardActionState) {
  states.set(key, state);
  listeners.forEach((fn) => fn());
}

export function cardActionState(key: string): CardActionState {
  return states.get(key) ?? IDLE;
}

/** A card's key: the chat it is in, the kind of card, and its message's time. */
export function cardKey(scope: string, kind: string, at: number) {
  return `${scope}:${kind}:${at}`;
}

/** A save refused because the thing changed since it was read. */
export function isConflict(err: unknown): boolean {
  // ApiError (client.ts), the conflict cachedClient throws, or the plain "API 409: …" of projectClient.ts
  return (err instanceof ApiError && err.status === 409) || !!(err as { conflict?: boolean } | null)?.conflict
    || (err instanceof Error && err.message.startsWith('API 409'));
}

class NoAnswer extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new NoAnswer(
      `No answer from the server after ${Math.round(ms / 1000)} s. It may still finish: reload to check, or try again.`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Run a card's action under `key`; a second run while one is going does
 *  nothing. `action` returns a note to show, or nothing. */
export async function runCardAction(key: string, action: () => Promise<string | void>,
                                    timeoutMs = CARD_TIMEOUT_MS): Promise<void> {
  if (cardActionState(key).busy) return;
  const run = ++lastRun;
  runs.set(key, run);
  put(key, { busy: true, error: '', note: '' });
  let state: CardActionState;
  try {
    let note: string | void;
    try {
      note = await withTimeout(action(), timeoutMs);
    } catch (err) {
      if (!isConflict(err)) throw err;
      note = await withTimeout(action(), timeoutMs);   // changed elsewhere: read it again, once
    }
    state = { busy: false, error: '', note: note || '' };
  } catch (err) {
    state = { busy: false, note: '', error: isConflict(err)
      ? 'It was changed elsewhere while saving, twice, so nothing was overwritten. Try again.' : errorText(err) };
  }
  if (runs.get(key) === run) put(key, state);
}

/** Forget a card's error or note (e.g. after Reject). */
export function clearCardAction(key: string) {
  if (states.has(key) && !cardActionState(key).busy) {
    states.delete(key);
    listeners.forEach((fn) => fn());
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** A card's action state, and running it. */
export function useCardAction(key: string) {
  const state = useSyncExternalStore(subscribe, () => cardActionState(key));
  return { ...state, run: (action: () => Promise<string | void>) => runCardAction(key, action) };
}

type CardKind = 'params' | 'brief' | 'held' | 'proposal';
type CardStatus<K extends CardKind> = NonNullable<ChatMessage[K]>['status'];

/** The chat with the card of `kind` under the message at `at` set to `status`
 *  (and `extra` merged into that message): found by its time, not its place,
 *  in the chat as it is now, so a message added meanwhile or another card's
 *  change is kept. */
export function withCardStatus<K extends CardKind>(messages: ChatMessage[], at: number, kind: K, status: CardStatus<K>,
                                                  extra: Partial<ChatMessage> = {}): ChatMessage[] {
  return messages.map((m) => (m.at === at && m[kind] ? { ...m, ...extra, [kind]: { ...m[kind]!, status } } : m));
}
