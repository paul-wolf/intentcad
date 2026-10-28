import { describe, expect, it } from 'vitest';
import { columnSort, searchDocs, sortDocs, type SearchableDoc } from './docSearch';

const doc = (name: string, over: Partial<SearchableDoc> = {}): SearchableDoc => ({
  name, project_id: 'p1', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
});
const projects: Record<string, string> = { p1: 'Drone frame', p2: 'Workbench' };
const projectName = (id: string | null) => (id ? projects[id] ?? '' : '');
const names = (ds: SearchableDoc[]) => ds.map((d) => d.name);

describe('searchDocs', () => {
  const docs = [
    doc('Top plate', { description: 'carries the flight controller', kind: 'part' }),
    doc('Arm', { kind: 'part', project_id: 'p2' }),
    doc('Layout', { outputs: ['plate_outline', 'brace_holes'] }),
    doc('Café sign', { project_id: null }),
  ];

  it('returns everything for an empty query', () => {
    expect(searchDocs(docs, '  ', projectName)).toEqual(docs);
  });

  it('matches the name, the description and the outputs, ignoring case', () => {
    expect(names(searchDocs(docs, 'PLATE', projectName))).toEqual(['Top plate', 'Layout']);
    expect(names(searchDocs(docs, 'flight', projectName))).toEqual(['Top plate']);
  });

  it('matches the project name, and needs every word', () => {
    expect(names(searchDocs(docs, 'workbench', projectName))).toEqual(['Arm']);
    expect(names(searchDocs(docs, 'drone plate', projectName))).toEqual(['Top plate', 'Layout']);
    expect(names(searchDocs(docs, 'workbench plate', projectName))).toEqual([]);
  });

  it('matches the kind and ignores accents', () => {
    expect(names(searchDocs(docs, 'sketch', projectName))).toEqual(['Layout', 'Café sign']);
    expect(names(searchDocs(docs, 'cafe', projectName))).toEqual(['Café sign']);
  });
});

describe('sortDocs', () => {
  const docs = [
    doc('Part 10', { updated_at: '2026-03-01T00:00:00Z', created_at: '2026-01-05T00:00:00Z', kind: 'part', project_id: 'p2' }),
    doc('part 2', { updated_at: '2026-02-01T00:00:00Z', created_at: '2026-01-09T00:00:00Z', kind: 'part' }),
    doc('Base', { updated_at: '2026-04-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' }),
  ];

  it('sorts by last edited both ways', () => {
    expect(names(sortDocs(docs, 'recent'))).toEqual(['Base', 'Part 10', 'part 2']);
    expect(names(sortDocs(docs, 'oldest'))).toEqual(['part 2', 'Part 10', 'Base']);
  });

  it('sorts names A to Z with numbers in order and case ignored', () => {
    expect(names(sortDocs(docs, 'az'))).toEqual(['Base', 'part 2', 'Part 10']);
    expect(names(sortDocs(docs, 'za'))).toEqual(['Part 10', 'part 2', 'Base']);
  });

  it('sorts by created date, by project and by kind', () => {
    expect(names(sortDocs(docs, 'created'))).toEqual(['part 2', 'Part 10', 'Base']);
    expect(names(sortDocs(docs, 'created-oldest'))).toEqual(['Base', 'Part 10', 'part 2']);
    expect(names(sortDocs(docs, 'project', projectName))).toEqual(['Base', 'part 2', 'Part 10']);
    expect(names(sortDocs(docs, 'kind'))).toEqual(['Part 10', 'part 2', 'Base']);
  });

  it('leaves the input alone', () => {
    const before = names(docs);
    sortDocs(docs, 'az');
    expect(names(docs)).toEqual(before);
  });
});

describe('columnSort', () => {
  it('flips a column on a second click', () => {
    expect(columnSort('name', 'recent')).toBe('az');
    expect(columnSort('name', 'az')).toBe('za');
    expect(columnSort('edited', 'recent')).toBe('oldest');
    expect(columnSort('edited', 'az')).toBe('recent');
    expect(columnSort('created', 'created')).toBe('created-oldest');
  });
});
