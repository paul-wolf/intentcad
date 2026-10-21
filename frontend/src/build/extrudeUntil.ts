/** The script that makes what an until extrude (Up to face / Up to next)
 *  adds or removes, alone, for the preview to draw through the part: the
 *  lines before the extrude line (the one on `line`, or the last line when it
 *  was just appended), the part kept as `_before`, the line, and the
 *  difference. null: no such line. */
export function untilPieceScript(code: string, line: number | null, op: 'cut' | 'join'): string | null {
  const rows = code.split('\n');
  let i = line != null ? line - 1 : rows.length - 1;
  if (line == null) while (i >= 0 && !rows[i]!.trim()) i--;
  const row = rows[i];
  if (row == null || !/^part [+-]= extrude\(.*\buntil=/.test(row)) return null;
  const diff = op === 'cut' ? '_before - part' : 'part - _before';
  return [...rows.slice(0, i), '_before = part', row, `part = ${diff}`, ''].join('\n');
}
