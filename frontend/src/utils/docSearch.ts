/** Finding documents: a search over names, descriptions, project names and a
 *  generated sketch's outputs, and the sort orders of the document lists. */

export interface SearchableDoc {
  name: string;
  description?: string;
  kind?: 'part' | 'sketch';
  outputs?: string[];
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export type DocSort = 'recent' | 'oldest' | 'az' | 'za' | 'created' | 'created-oldest' | 'project' | 'kind';

export const DOC_SORTS: { key: DocSort; label: string; acrossProjects?: boolean }[] = [
  { key: 'recent', label: 'Last edited, newest first' },
  { key: 'oldest', label: 'Last edited, oldest first' },
  { key: 'az', label: 'Name, A to Z' },
  { key: 'za', label: 'Name, Z to A' },
  { key: 'created', label: 'Created, newest first' },
  { key: 'created-oldest', label: 'Created, oldest first' },
  { key: 'project', label: 'Project', acrossProjects: true },
  { key: 'kind', label: 'Parts, then sketches' },
];

export function isDocSort(s: unknown): s is DocSort {
  return DOC_SORTS.some((o) => o.key === s);
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The documents whose name, description, project name, kind or outputs hold
 *  every word of the query ("frame plate" finds "Plate" in project "Frame"). */
export function searchDocs<D extends SearchableDoc>(docs: D[], query: string, projectName: (id: string | null) => string = () => ''): D[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return docs;
  return docs.filter((d) => {
    const hay = fold([d.name, d.description ?? '', projectName(d.project_id), d.kind ?? 'sketch', ...(d.outputs ?? [])].join('\n'));
    return words.every((w) => hay.includes(w));
  });
}

const byName = (a: SearchableDoc, b: SearchableDoc) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const newest = (a: string, b: string) => b.localeCompare(a);

/** A sorted copy. Ties fall back to the last edited first, then the name:
 *  "Part 2" comes before "Part 10". */
export function sortDocs<D extends SearchableDoc>(docs: D[], sort: DocSort, projectName: (id: string | null) => string = () => ''): D[] {
  const tie = (a: D, b: D) => newest(a.updated_at, b.updated_at) || byName(a, b);
  const cmp: Record<DocSort, (a: D, b: D) => number> = {
    recent: tie,
    oldest: (a, b) => newest(b.updated_at, a.updated_at) || byName(a, b),
    az: (a, b) => byName(a, b) || tie(a, b),
    za: (a, b) => byName(b, a) || tie(a, b),
    created: (a, b) => newest(a.created_at, b.created_at) || byName(a, b),
    'created-oldest': (a, b) => newest(b.created_at, a.created_at) || byName(a, b),
    project: (a, b) => projectName(a.project_id).localeCompare(projectName(b.project_id), undefined, { numeric: true, sensitivity: 'base' }) || tie(a, b),
    kind: (a, b) => Number(a.kind !== 'part') - Number(b.kind !== 'part') || tie(a, b),
  };
  return [...docs].sort(cmp[sort]);
}

/** Clicking a list column's header: its natural order first, then the reverse. */
export function columnSort(column: 'name' | 'edited' | 'created' | 'project' | 'kind', current: DocSort): DocSort {
  switch (column) {
    case 'name': return current === 'az' ? 'za' : 'az';
    case 'edited': return current === 'recent' ? 'oldest' : 'recent';
    case 'created': return current === 'created' ? 'created-oldest' : 'created';
    case 'project': return 'project';
    case 'kind': return 'kind';
  }
}
