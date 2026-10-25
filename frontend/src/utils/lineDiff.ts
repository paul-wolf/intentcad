/** A line diff (longest common subsequence) for showing the AI's proposed
 *  brief against the current one. */

export interface DiffLine { op: 'same' | 'add' | 'del'; text: string }

const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  // the common head and tail first: a typical edit touches a few lines
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const same = (xs: string[]) => xs.map((text): DiffLine => ({ op: 'same', text }));
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  return [...same(a.slice(0, head)), ...middle(midA, midB), ...same(a.slice(a.length - tail))];
}

function middle(a: string[], b: string[]): DiffLine[] {
  const n = a.length, m = b.length;
  if (n * m > MAX_CELLS) {
    return [...a.map((text): DiffLine => ({ op: 'del', text })), ...b.map((text): DiffLine => ({ op: 'add', text }))];
  }
  // lcs[i][j]: the longest common subsequence of a[i:] and b[j:]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: 'same', text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: 'del', text: a[i++]! });
    else out.push({ op: 'add', text: b[j++]! });
  }
  while (i < n) out.push({ op: 'del', text: a[i++]! });
  while (j < m) out.push({ op: 'add', text: b[j++]! });
  return out;
}

/** Counts for a one-line summary: "+3 −1 lines". */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.op === 'add').length, removed: lines.filter((l) => l.op === 'del').length };
}

export function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}
