/**
 * Context files: reference PDFs and images the AI reads with each message
 * (backend: documents/context.py). What gets sent is decided here, so the
 * cards, the chat chips and the edit request agree.
 */
import type { CallSpend, ContextFile, ContextFiles, EditResponse, UsageResponse } from '@/api/client';
import type { User } from '@/types/auth';

/** What the file pickers offer (HEIC photos are converted to JPEG on upload). */
export const CONTEXT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif';

const ACCEPT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
const ACCEPT_EXT = /\.(pdf|png|jpe?g|webp|heic|heif)$/i;

/** Whether a dropped or pasted file looks like one the server takes (it
 *  checks the bytes; this only keeps obviously wrong drops out). */
export function acceptable(f: { name: string; type: string }): boolean {
  return ACCEPT_TYPES.includes(f.type) || ACCEPT_EXT.test(f.name);
}

/** All the files of a part, the project's first (they head the AI's prompt). */
export function allFiles(c: ContextFiles | null): ContextFile[] {
  return c ? [...c.project, ...c.part] : [];
}

/** The pages of a file that are sent (1-based); an image is one page. */
export function includedPages(f: ContextFile): number[] {
  const n = f.page_count ?? 1;
  if (f.pages == null) return Array.from({ length: n }, (_, i) => i + 1);
  return f.pages.filter((p) => p >= 1 && p <= n);
}

/** The files the next message sends: in context, with a page to send, and
 *  not removed for this message (`skipped`). */
export function filesToSend(c: ContextFiles | null, skipped: ReadonlySet<string>): ContextFile[] {
  return allFiles(c).filter((f) => f.in_context && includedPages(f).length > 0 && !skipped.has(f.id));
}

/** The ids the edit request leaves out: in context, but removed for this message. */
export function skipList(c: ContextFiles | null, skipped: ReadonlySet<string>): string[] {
  return allFiles(c).filter((f) => f.in_context && skipped.has(f.id)).map((f) => f.id);
}

/** Estimated input tokens for the pages currently included. */
export function fileTokens(f: ContextFile): number {
  return includedPages(f).reduce((sum, p) => sum + (f.page_tokens[p - 1] ?? 0), 0);
}

/** 1234 -> "1.2k", 950 -> "950". */
export function tokensLabel(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** [1, 2, 3, 6] -> "1–3, 6". */
export function pageRanges(pages: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    out.push(i === j ? `${pages[i]}` : `${pages[i]}–${pages[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/** "7 pages · 9.8 MB", "pages 5–6 of 7 · 9.8 MB", "1600 × 1200 · 240 KB". */
export function detailLabel(f: ContextFile): string {
  if (f.page_count == null) {
    return `${f.width && f.height ? `${f.width} × ${f.height}` : 'image'} · ${sizeLabel(f.size)}`;
  }
  const inc = includedPages(f);
  const pages = inc.length === f.page_count
    ? `${f.page_count} page${f.page_count === 1 ? '' : 's'}`
    : inc.length === 0 ? `no pages of ${f.page_count}` : `pages ${pageRanges(inc)} of ${f.page_count}`;
  return `${pages} · ${sizeLabel(f.size)}`;
}

/** The pages after toggling `page` in or out: null when that is all of them
 *  (the server's "all", which also covers pages added later). */
export function togglePage(f: ContextFile, page: number): number[] | null {
  const n = f.page_count ?? 1;
  const cur = new Set(includedPages(f));
  if (cur.has(page)) cur.delete(page); else cur.add(page);
  return cur.size === n ? null : [...cur].sort((a, b) => a - b);
}

/** "14k in (11k cached) · 1.2k out · $0.031" for one AI call. */
export function usageLabel(r: CallSpend): string {
  const cached = r.cache_read_tokens ? ` (${tokensLabel(r.cache_read_tokens)} cached)` : '';
  return `${tokensLabel(r.tokens_in)} in${cached} · ${tokensLabel(r.tokens_out)} out · $${r.cost_usd.toFixed(3)}`;
}

// ---- the AI spend: staff and superusers only (the server leaves it out for everyone else) ----

export const seesSpend = (u: Pick<User, 'is_staff' | 'is_superuser'> | null | undefined): boolean =>
  !!(u?.is_staff || u?.is_superuser);

/** An edit's usage note for the chat, when the response carries its spend. */
export function spendNote(r: Pick<EditResponse, 'tokens_in' | 'tokens_out' | 'cost_usd' | 'cache_read_tokens'>):
  string | undefined {
  if (typeof r.cost_usd !== 'number') return undefined;
  return usageLabel({ tokens_in: r.tokens_in ?? 0, tokens_out: r.tokens_out ?? 0, cost_usd: r.cost_usd,
                      cache_read_tokens: r.cache_read_tokens });
}

/** A chat message's usage note, if this user sees it (notes saved earlier
 *  stay in the chat history; they're hidden, not shown, for everyone else). */
export const chatUsageNote = (u: Pick<User, 'is_staff' | 'is_superuser'> | null | undefined, note?: string) =>
  (seesSpend(u) && note ? note : null);

/** The status line under the top bar: this part's and all-time spend, for
 *  staff (null: no line). */
export function spendLine(u: Pick<User, 'is_staff' | 'is_superuser'> | null | undefined,
                          usage: UsageResponse | null): string | null {
  if (!seesSpend(u) || !usage) return null;
  const { document: d, all_time: a } = usage;
  return `AI spend · this model $${d.cost_usd.toFixed(3)} (${d.edits}) · all-time $${a.cost_usd.toFixed(2)} (${a.edits})`;
}

/** Whether the AI's question asks for something the user would answer with a
 *  file: a photo, a drawing, a datasheet, a scan (not an error message). */
export function asksForFile(text: string): boolean {
  if (text.startsWith('⚠')) return false;
  return /\b(photos?|pictures?|images?|drawings?|datasheets?|data sheets?|screenshots?|scans?|pdfs?|attach\w*|upload\w*)\b/i.test(text);
}
