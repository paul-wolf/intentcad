/**
 * The part's parameters as written in its script: the numbers in
 * `P = dict(a=1, b=2.5)` or `P = {"a": 1}` (or `params = ...`), read from the
 * text without running it — the same assignment backend/modeling/paramedit.py
 * edits: the first top-level `P =` / `params =` whose value is a dict(...)
 * call or a {...} literal.
 */

export interface ScriptParams {
  /** a P / params dict was found */
  found: boolean;
  /** keys whose value is a number literal (negatives too) */
  values: Record<string, number>;
  /** keys whose value is anything else (an expression, a string, ...) */
  others: string[];
}

const NUMBER = /^[+-]?\s*(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?$/;

/** Python string literal starting at s[i] (with an optional r/b/u/f prefix
 *  already skipped): the index just after it. */
function skipString(s: string, i: number): number {
  const q = s[i]!;
  const triple = s.startsWith(q.repeat(3), i);
  const close = triple ? q.repeat(3) : q;
  let j = i + close.length;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s.startsWith(close, j)) return j + close.length;
    if (!triple && s[j] === '\n') return j;
    j++;
  }
  return j;
}

/** Index just after the expression starting at `i`: up to a comma or closing
 *  bracket at depth 0, skipping strings, comments and nested brackets. */
function scanValue(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"' || c === "'") { i = skipString(s, i); continue; }
    if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (c === ',' && depth === 0) return i;
    i++;
  }
  return i;
}

function skipBlank(s: string, i: number): number {
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    return i;
  }
}

/** Start of each top-level statement line (column 0, outside strings and brackets). */
function* topLevelLines(s: string): Generator<number> {
  let depth = 0;
  let lineStart = true;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (lineStart && depth === 0 && c !== '\n') yield i;
    lineStart = false;
    if (c === '"' || c === "'") { i = skipString(s, i); continue; }
    if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--;
    else if (c === '\\' && s[i + 1] === '\n') { i += 2; continue; }
    else if (c === '\n') lineStart = true;
    i++;
  }
}

function number(text: string): number | null {
  const t = text.trim();
  if (!NUMBER.test(t)) return null;
  const v = Number(t.replace(/[\s_]/g, ''));
  return isFinite(v) ? v : null;
}

export function scriptParams(code: string): ScriptParams {
  const none: ScriptParams = { found: false, values: {}, others: [] };
  for (const at of topLevelLines(code)) {
    const m = /^(P|params)[ \t]*=(?!=)[ \t]*/.exec(code.slice(at, at + 40));
    if (!m) continue;
    let i = at + m[0].length;
    const values: Record<string, number> = {};
    const others: string[] = [];
    const put = (key: string, text: string) => {
      const v = number(text);
      if (v === null) others.push(key);
      else values[key] = v;
    };
    if (/^dict[ \t]*\(/.test(code.slice(i))) {
      i = code.indexOf('(', i) + 1;
      for (;;) {
        i = skipBlank(code, i);
        if (i >= code.length || code[i] === ')') break;
        const kw = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(code.slice(i));
        const end = scanValue(code, kw ? i + kw[0].length : i);
        if (kw) put(kw[1]!, code.slice(i + kw[0].length, end));   // **spread / positional: skipped
        i = end;
        if (code[i] === ',') i++;
        else break;
      }
      return { found: true, values, others };
    }
    if (code[i] === '{') {
      i++;
      for (;;) {
        i = skipBlank(code, i);
        if (i >= code.length || code[i] === '}') break;
        // only plain string keys count ("a": 1); anything else is skipped
        const quoted = code[i] === '"' || code[i] === "'";
        const keyEnd = quoted ? skipString(code, i) : i;
        const colon = skipBlank(code, keyEnd);
        if (quoted && code[colon] === ':') {
          const end = scanValue(code, colon + 1);
          put(code.slice(i + 1, keyEnd - 1), code.slice(colon + 1, end));
          i = end;
        } else {
          i = scanValue(code, keyEnd);
        }
        if (code[i] === ',') i++;
        else break;
      }
      return { found: true, values, others };
    }
    return none;   // the first P = is something else: paramedit gives up too
  }
  return none;
}

/** The numbers a face-sketch dimension can use from the part: the script's
 *  P, with keys whose value isn't a plain number taken from the last build
 *  (`built`, RunResponse.params). With no P dict to read, the last build's
 *  params as they are. */
export function partParams(code: string, built?: Record<string, number> | null): Record<string, number> {
  const p = scriptParams(code);
  if (!p.found) return { ...(built ?? {}) };
  const out: Record<string, number> = {};
  for (const k of p.others) if (built && typeof built[k] === 'number') out[k] = built[k]!;
  return Object.assign(out, p.values);
}
