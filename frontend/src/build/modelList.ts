/**
 * The AI model picker keeps itself current: the server asks the Models API
 * (backend: modeling/llm_models.py) and the page asks the server again when
 * its list is old — on returning to the tab or opening the picker.
 */
import type { ModelsResponse } from '@/api/client';

/** How old the page's list may get before it asks again (ms). A static
 *  snapshot (the server couldn't reach the API) is retried sooner. */
export const MODELS_MAX_AGE = { live: 10 * 60_000, static: 60_000 } as const;

export function modelsStale(fetchedAt: number, source: ModelsResponse['source'] | null, now: number): boolean {
  if (!fetchedAt || !source) return true;
  return now - fetchedAt > MODELS_MAX_AGE[source];
}

/** The model to select after a (re)load: the user's own pick while it is
 *  still offered, otherwise the server's default — so someone who never
 *  chose follows the default as new models ship. */
export function chooseModel(current: string, r: Pick<ModelsResponse, 'models' | 'default'>, picked: boolean): string {
  return picked && current && r.models.some((m) => m.id === current) ? current : r.default;
}
