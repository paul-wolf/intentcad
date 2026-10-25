/** @-mentions in the part chat: typing @ lists the project's other parts and
 *  sketches; each one named as "@Name" in the message goes with it (its summary
 *  is attached server-side, see modeling/project_context.mention_context). */

export interface Mentionable { id: string; name: string; kind?: 'part' | 'sketch' }

/** The mention being typed just before the caret: where its @ is and what
 *  follows it, or null when the caret isn't in one. An @ inside a word (an
 *  email address) doesn't start a mention. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (query.length > 80 || query.includes('\n')) return null;
  return { start: at, query };
}

/** The documents whose name contains the query (case-insensitive): names that
 *  start with it first, then by name. */
export function matchMentions<T extends Mentionable>(docs: T[], query: string, limit = 8): T[] {
  const q = query.trim().toLowerCase();
  const hits = docs.filter((d) => d.name.toLowerCase().includes(q));
  const rank = (d: T) => (d.name.toLowerCase().startsWith(q) ? 0 : 1);
  return hits.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, limit);
}

/** The text with the typed mention (from its @ to the caret) replaced by
 *  "@Name ", and where the caret goes after it. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const ins = `@${name} `;
  const rest = text.slice(caret).replace(/^ /, '');
  return { text: text.slice(0, start) + ins + rest, caret: start + ins.length };
}

/** The ids of the documents named as "@Name" in the text, in the order they
 *  appear. Longer names are matched first, so "@Plate 2" isn't also "@Plate". */
export function mentionedIds(text: string, docs: Mentionable[]): string[] {
  let rest = text.toLowerCase();
  const found: { id: string; at: number }[] = [];
  for (const d of [...docs].sort((a, b) => b.name.length - a.name.length)) {
    const tag = `@${d.name.toLowerCase()}`;
    for (let at = rest.indexOf(tag); at >= 0; at = rest.indexOf(tag, at + 1)) {
      const next = rest[at + tag.length];
      if (next !== undefined && /[\p{L}\p{N}_]/u.test(next)) continue;   // "@Plate" in "@Plates"
      if (at > 0 && !/\s/.test(rest[at - 1]!)) continue;
      found.push({ id: d.id, at });
      rest = rest.slice(0, at) + ' '.repeat(tag.length) + rest.slice(at + tag.length);
      break;
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.id);
}
