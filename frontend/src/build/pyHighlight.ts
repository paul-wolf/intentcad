/**
 * Tiny, dependency-free Python syntax highlighter for the build123d script
 * editor. Emits an HTML string of colored <span>s to render behind a
 * transparent <textarea> (the standard overlay trick). Not a full parser —
 * a single tokenizer pass over comments, strings, numbers, and identifiers,
 * which is plenty for these short scripts.
 */

export interface SyntaxColors {
  comment: string;
  string: string;
  number: string;
  keyword: string;
  known: string;
}

const KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'True', 'False', 'None',
]);

// build123d vocabulary + common builtins, colored as "known names"
const KNOWN = new Set([
  'Box', 'Cylinder', 'Sphere', 'Cone', 'Torus', 'Wedge', 'Pos', 'Rot', 'Location',
  'Plane', 'Axis', 'GeomType', 'SortBy', 'Vector', 'Compound', 'Part', 'Solid',
  'Sketch', 'Circle', 'Rectangle', 'Polyline', 'Line', 'Ellipse', 'RegularPolygon',
  'fillet', 'chamfer', 'extrude', 'revolve', 'loft', 'sweep', 'mirror', 'offset',
  'part', 'result',
  'dict', 'list', 'tuple', 'set', 'range', 'len', 'abs', 'min', 'max', 'round',
  'sum', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'print', 'float', 'int',
  'str', 'bool',
]);

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// order matters: comment and strings must win over identifiers/numbers
const TOKEN = /#[^\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\d[\d_.]*|[A-Za-z_]\w*/g;

export function highlightPython(code: string, c: SyntaxColors): string {
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(code)) !== null) {
    const tok = m[0];
    out += esc(code.slice(last, m.index));
    last = m.index + tok.length;
    const ch = tok[0]!;
    let color: string | null = null;
    if (ch === '#') color = c.comment;
    else if (ch === '"' || ch === "'") color = c.string;
    else if (ch >= '0' && ch <= '9') color = c.number;
    else if (KEYWORDS.has(tok)) color = c.keyword;
    else if (KNOWN.has(tok)) color = c.known;
    out += color ? `<span style="color:${color}">${esc(tok)}</span>` : esc(tok);
  }
  out += esc(code.slice(last));
  return out;
}

export const DARK_SYNTAX: SyntaxColors = {
  comment: '#6a9955', string: '#ce9178', number: '#b5cea8',
  keyword: '#569cd6', known: '#4ec9b0',
};
export const LIGHT_SYNTAX: SyntaxColors = {
  comment: '#5a7a4a', string: '#a3402f', number: '#1c7a52',
  keyword: '#1f5fbf', known: '#177066',
};
