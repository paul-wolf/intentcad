import type { CSSProperties, ReactNode } from 'react';

/** A small Markdown renderer for the project brief and the AI's answers:
 *  headings, paragraphs, lists, quotes, code, rules, **bold**, *italic*,
 *  `code` and [links](https://…). It builds React elements, never HTML, so
 *  text written by anyone in the project can't inject markup. */

export type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'quote'; text: string }
  | { t: 'code'; text: string }
  | { t: 'hr' };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { out.push({ t: 'h', level: h[1]!.length, text: h[2]! }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ t: 'hr' }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      out.push({ t: 'quote', text: body.join('\n') });
      continue;
    }
    const list = BULLET.test(line) ? 'ul' : NUMBER.test(line) ? 'ol' : null;
    if (list) {
      const re = list === 'ul' ? BULLET : NUMBER;
      const items: string[] = [];
      while (i < lines.length && lines[i]!.trim()) {
        const m = re.exec(lines[i]!);
        if (m) items.push(m[1]!);
        else if (/^\s+/.test(lines[i]!) && items.length) items[items.length - 1] += ' ' + lines[i]!.trim();   // a wrapped item
        else break;
        i++;
      }
      out.push({ t: list, items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*```|\s*>)/.test(lines[i]!)
           && !BULLET.test(lines[i]!) && !NUMBER.test(lines[i]!)) body.push(lines[i++]!);
    out.push({ t: 'p', text: body.join('\n') });
  }
  return out;
}

// _ and __ only at word edges, so names such as prop_d and tip_gap stay as written
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|(?<!\w)__[^_]+__(?!\w))|(\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))|(\[[^\]]+\]\([^)\s]+\))/;

export function inline(text: string, codeStyle?: CSSProperties): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text, k = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(...breaks(rest, k)); break; }
    if (m.index) out.push(...breaks(rest.slice(0, m.index), k));
    const s = m[0];
    k++;
    if (m[1]) out.push(<code key={k} style={codeStyle}>{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(s.slice(2, -2), codeStyle)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(s.slice(1, -1), codeStyle)}</em>);
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(s)!;
      out.push(/^(https?:|mailto:)/i.test(href!)
        ? <a key={k} href={href} target="_blank" rel="noopener noreferrer">{label}</a>
        : <span key={k}>{s}</span>);
    }
    rest = rest.slice(m.index + s.length);
  }
  return out;
}

function breaks(text: string, k: number): ReactNode[] {
  return text.split('\n').flatMap((part, i) => (i ? [<br key={`b${k}-${i}`} />, part] : [part]));
}

export function Markdown({ text, color, dim, border, codeBg, style }: {
  text: string; color: string; dim: string; border: string; codeBg: string; style?: CSSProperties;
}) {
  const code: CSSProperties = { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.92em', background: codeBg,
                                padding: '1px 4px', borderRadius: 4 };
  const sizes = [0, 1.35, 1.18, 1.05, 1, 1, 1];
  return (
    <div style={{ color, lineHeight: 1.55, ...style }}>
      {parseBlocks(text).map((b, i) => {
        const gap: CSSProperties = { margin: i ? '0.6em 0 0' : 0 };
        switch (b.t) {
          case 'h': return <div key={i} role="heading" aria-level={b.level}
            style={{ ...gap, marginTop: i ? '0.9em' : 0, fontWeight: 700, fontSize: `${sizes[b.level]}em` }}>{inline(b.text, code)}</div>;
          case 'p': return <p key={i} style={gap}>{inline(b.text, code)}</p>;
          case 'ul': return <ul key={i} style={{ ...gap, paddingLeft: '1.3em' }}>{b.items.map((it, j) => <li key={j}>{inline(it, code)}</li>)}</ul>;
          case 'ol': return <ol key={i} style={{ ...gap, paddingLeft: '1.5em' }}>{b.items.map((it, j) => <li key={j}>{inline(it, code)}</li>)}</ol>;
          case 'quote': return <blockquote key={i} style={{ ...gap, padding: '0 0 0 10px', borderLeft: `3px solid ${border}`, color: dim }}>{inline(b.text, code)}</blockquote>;
          case 'code': return <pre key={i} style={{ ...gap, ...code, padding: '8px 10px', overflowX: 'auto', whiteSpace: 'pre' }}>{b.text}</pre>;
          case 'hr': return <hr key={i} style={{ ...gap, border: 'none', borderTop: `1px solid ${border}` }} />;
        }
      })}
    </div>
  );
}
