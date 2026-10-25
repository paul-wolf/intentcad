import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { insertMention, matchMentions, mentionedIds, mentionQuery } from './mentions';
import { diffStats, lineDiff, wordCount } from './lineDiff';
import { Markdown, parseBlocks } from '@/ui/Markdown';

const DOCS = [
  { id: 'a', name: 'Bottom plate' }, { id: 'b', name: 'Top plate' }, { id: 'c', name: 'Arm brace' },
  { id: 'd', name: 'Plate' }, { id: 'e', name: 'Plate 2' },
];

describe('mentions', () => {
  it('finds the mention being typed', () => {
    expect(mentionQuery('match @bot', 10)).toEqual({ start: 6, query: 'bot' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('match @Bottom pl', 16)).toEqual({ start: 6, query: 'Bottom pl' });
    expect(mentionQuery('mail me@x.com', 13)).toBeNull();
    expect(mentionQuery('no mention', 10)).toBeNull();
    expect(mentionQuery('@Arm brace and then', 4)).toEqual({ start: 0, query: 'Arm' });   // the caret, not the end
  });

  it('matches names containing the query, prefixes first', () => {
    expect(matchMentions(DOCS, 'plate').map((d) => d.name)).toEqual(['Plate', 'Plate 2', 'Bottom plate', 'Top plate']);
    expect(matchMentions(DOCS, 'bottom pl').map((d) => d.id)).toEqual(['a']);
    expect(matchMentions(DOCS, '').length).toBe(5);
    expect(matchMentions(DOCS, 'zzz')).toEqual([]);
  });

  it('inserts the picked name', () => {
    expect(insertMention('match @bo now', 6, 9, 'Bottom plate')).toEqual({ text: 'match @Bottom plate now', caret: 20 });
    expect(insertMention('@', 0, 1, 'Arm brace')).toEqual({ text: '@Arm brace ', caret: 11 });
  });

  it('collects the ids named in a message, longest names first', () => {
    expect(mentionedIds('make it match @bottom plate and @Arm brace.', DOCS)).toEqual(['a', 'c']);
    expect(mentionedIds('compare @Plate 2 with @Plate', DOCS)).toEqual(['e', 'd']);
    expect(mentionedIds('@Plates are not @Plate', DOCS)).toEqual(['d']);
    expect(mentionedIds('email bob@Plate', DOCS)).toEqual([]);
    expect(mentionedIds('no mentions', DOCS)).toEqual([]);
  });
});

describe('lineDiff', () => {
  it('keeps the common lines and marks the changes', () => {
    const d = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
    expect(d).toEqual([
      { op: 'same', text: 'a' }, { op: 'del', text: 'b' }, { op: 'add', text: 'B' },
      { op: 'same', text: 'c' }, { op: 'same', text: 'd' }, { op: 'add', text: 'e' }]);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });

  it('handles empty sides', () => {
    expect(lineDiff('', 'x\ny')).toEqual([{ op: 'add', text: 'x' }, { op: 'add', text: 'y' }]);
    expect(lineDiff('x', '')).toEqual([{ op: 'del', text: 'x' }]);
    expect(lineDiff('same', 'same')).toEqual([{ op: 'same', text: 'same' }]);
  });

  it('counts words', () => {
    expect(wordCount('  Carbon fibre,\n2 mm  ')).toBe(4);
    expect(wordCount('')).toBe(0);
  });
});

describe('Markdown', () => {
  it('parses the blocks', () => {
    expect(parseBlocks('# Drone\n\nCarbon *fibre*\nplates\n\n- M3\n- M2.5\n\n1. one\n2. two\n\n> note\n\n---\n\n```\ncode\n```').map((b) => b.t))
      .toEqual(['h', 'p', 'ul', 'ol', 'quote', 'hr', 'code']);
  });

  it('renders elements, never raw HTML', () => {
    const md = (text: string) => renderToStaticMarkup(createElement(Markdown, { text, color: '#000', dim: '#666', border: '#ccc', codeBg: '#eee' }));
    const html = md('**2 mm** carbon, `M3` and [spec](https://example.com) <img src=x onerror=alert(1)>');
    expect(html).toContain('<strong>2 mm</strong>');
    expect(html).toContain('M3</code>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(md('[x](javascript:alert(1))')).not.toContain('href');
  });
});
