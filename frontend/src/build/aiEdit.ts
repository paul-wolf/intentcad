/**
 * An AI edit of a part, when its reply comes: it goes in straight away only
 * if the part is still the version the AI started from and every project
 * parameter it reads exists. Otherwise it waits on a card in the chat, to
 * apply or not (a part changed meanwhile is never overwritten unasked).
 */

const PP_READ = /\bPP(?:\[\s*|\.get\(\s*)(["'])(.+?)\1/g;

/** The project parameters `code` reads (PP["name"]), each once. */
export function ppReads(code: string): string[] {
  return [...new Set([...code.matchAll(PP_READ)].map((m) => m[2]!))];
}

export interface HeldWhy {
  /** the part changed while the AI worked: applying its edit replaces that change */
  changed: boolean;
  /** proposed project parameters the edit reads, not accepted yet */
  waits: string[];
}

/** Why the edit `code` (made from `base`) can't go in now that the part is
 *  `now`; null when it can. `proposed`: the parameters it proposed. */
export function holdAiEdit(base: string, now: string, code: string, proposed: { name: string }[] | null | undefined): HeldWhy | null {
  const names = new Set((proposed ?? []).map((p) => p.name));
  const waits = ppReads(code).filter((n) => names.has(n));
  const changed = now !== base;
  return changed || waits.length ? { changed, waits } : null;
}
