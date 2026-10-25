/**
 * A sketch document's sharing panel (right side of the sketch editor): the
 * active sketch's groups (Group… names the selected elements, for parts:
 * SK["alias"].group("name")), and the parts that use the document's
 * sketches, each up to date or not, with Rebuild all.
 */
import { useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentStore } from '@/stores/documentStore';
import { useEditorStore } from '@/stores/editorStore';
import { useThemeStore } from '@/theme';
import { requestSave, getBackendId, subscribeBackendId } from '@/api/autoSave';
import { buildApi, errorText } from '@/api/client';
import { getUsers, refreshUsers, subscribeSharedUses } from '@/api/sharedUses';
import { addLog } from '@/stores/logStore';

const isSketchDoc = (d: { type?: string; modelCode?: string }) =>
  d.type === 'sketch' || (d.type !== 'part' && !d.modelCode?.trim());

export function SharedSketchPanel() {
  const palette = useThemeStore((s) => s.palette);
  const sketchDoc = useDocumentStore((s) => isSketchDoc(s.document));
  const sketch = useDocumentStore((s) => s.getActiveSketch());
  const selected = useEditorStore((s) => s.selectedEntityIds);
  const backendId = useSyncExternalStore(subscribeBackendId, getBackendId);
  const users = useSyncExternalStore(subscribeSharedUses, getUsers);
  const [naming, setNaming] = useState<string | null>(null);   // the new group's name while typing
  const [renaming, setRenaming] = useState<{ old: string; name: string } | null>(null);
  const [rebuild, setRebuild] = useState<{ at: string; done: string[]; failed: string[] } | null>(null);

  if (!sketchDoc || !sketch) return null;
  const groups = sketch.groups ?? [];
  const ids = new Set(sketch.entities.map((e) => e.id));
  const picked = [...selected].filter((id) => ids.has(id));

  const saveGroups = (next: typeof groups, label: string) => {
    const store = useDocumentStore.getState();
    store.beginTransaction(label);
    store.setSketchGroups(sketch.id, next);
    requestSave();
  };
  const addGroup = () => {
    const name = naming?.trim();
    setNaming(null);
    if (!name || !picked.length) return;
    // a group of the same name takes the new selection
    saveGroups([...groups.filter((g) => g.name !== name), { name, ids: picked }], `Group "${name}"`);
  };
  const commitRename = () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    setRenaming(null);
    if (!name || name === renaming.old || groups.some((g) => g.name === name)) return;
    saveGroups(groups.map((g) => (g.name === renaming.old ? { ...g, name } : g)), `Rename group "${renaming.old}"`);
  };

  const stale = users.filter((p) => p.stale.length);
  const rebuildAll = async () => {
    const state = { at: '', done: [] as string[], failed: [] as string[] };
    for (const p of stale) {
      state.at = p.name;
      setRebuild({ ...state });
      try {
        const r = await buildApi.rebuild(p.id);
        if (r.ok) state.done.push(p.name);
        else state.failed.push(`${p.name}: ${r.error || r.warning}`);
      } catch (err) {
        state.failed.push(`${p.name}: ${errorText(err)}`);
      }
    }
    setRebuild({ ...state, at: '' });
    state.failed.forEach((f) => addLog('error', `Rebuild ${f}`));
    if (backendId) void refreshUsers(backendId);
  };

  const head: React.CSSProperties = {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px',
    borderBottom: `1px solid ${palette.border}`, fontSize: '12px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.5px', color: palette.textMuted,
  };
  const btn: React.CSSProperties = {
    background: 'none', border: `1px solid ${palette.inputBorder}`, borderRadius: '3px',
    color: palette.textSecondary, cursor: 'pointer', fontSize: '11px', padding: '2px 6px',
    textTransform: 'none', letterSpacing: 0, fontWeight: 400,
  };
  const input: React.CSSProperties = {
    flex: 1, minWidth: 0, background: palette.inputBg, border: `1px solid ${palette.inputBorder}`,
    borderRadius: '2px', color: palette.text, fontSize: '12px', padding: '2px 4px', outline: 'none',
  };
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px', fontSize: '12px' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', borderBottom: `1px solid ${palette.border}` }}>
      <div style={head}>
        <span>Groups</span>
        <button style={{ ...btn, opacity: picked.length ? 1 : 0.5 }} disabled={!picked.length}
                onClick={() => setNaming('')}
                title={picked.length ? `Name the ${picked.length} selected element(s) as a group, for parts: SK["alias"].group("name")`
                  : 'Select elements first, then name them as a group'}>
          Group…
        </button>
      </div>
      {naming !== null && (
        <div style={row}>
          <input style={input} autoFocus value={naming} placeholder={`name for ${picked.length} element(s)`}
                 onChange={(e) => setNaming(e.target.value)} onBlur={addGroup}
                 onKeyDown={(e) => { if (e.key === 'Enter') addGroup(); if (e.key === 'Escape') setNaming(null); }} />
        </div>
      )}
      {groups.map((g) => {
        const n = g.ids.filter((id) => ids.has(id)).length;
        return (
          <div key={g.name} style={{ ...row, cursor: 'pointer' }}
               onClick={() => useEditorStore.getState().setSelectedEntityIds(new Set(g.ids.filter((id) => ids.has(id))))}
               title="Click to select its elements; double-click to rename">
            {renaming?.old === g.name ? (
              <input style={input} autoFocus value={renaming.name}
                     onChange={(e) => setRenaming({ old: g.name, name: e.target.value })} onBlur={commitRename}
                     onClick={(e) => e.stopPropagation()}
                     onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }} />
            ) : (
              <span style={{ flex: 1, color: palette.text }} onDoubleClick={() => setRenaming({ old: g.name, name: g.name })}>
                {g.name}
              </span>
            )}
            <span style={{ color: palette.textMuted }}>{n}</span>
            <button style={{ ...btn, border: 'none', padding: '0 2px' }} title="Delete the group (its elements stay)"
                    onClick={(e) => { e.stopPropagation(); saveGroups(groups.filter((x) => x.name !== g.name), `Delete group "${g.name}"`); }}>
              ×
            </button>
          </div>
        );
      })}
      {!groups.length && naming === null && (
        <div style={{ ...row, color: palette.textMuted, fontSize: '11px' }}>
          Select elements and press Group… so parts can use them by name.
        </div>
      )}

      {users.length > 0 && (
        <>
          <div style={{ ...head, borderTop: `1px solid ${palette.border}` }}>
            <span>Used by</span>
            <button style={{ ...btn, opacity: stale.length && !rebuild?.at ? 1 : 0.5 }}
                    disabled={!stale.length || !!rebuild?.at} onClick={() => void rebuildAll()}
                    title={stale.length ? `Rebuild the ${stale.length} out-of-date part(s) with this sketch as it is now`
                      : 'Every part is built with this sketch as it is now'}>
              Rebuild all
            </button>
          </div>
          {users.map((p) => (
            <Link key={p.id} to={`/part/${p.id}`} style={{ ...row, textDecoration: 'none', color: palette.text }}
               title={p.uses.map((u) => `SK["${u.alias}"]`).join(', ')}>
              <span style={{ flex: 1 }}>{p.name}</span>
              <span style={{ fontSize: '11px', color: p.stale.length ? palette.warning : palette.textMuted }}
                    title={p.stale.join(', ')}>
                {p.pinned ? 'pinned' : p.stale.length ? 'out of date' : 'up to date'}
              </span>
            </Link>
          ))}
          {rebuild && (
            <div style={{ ...row, fontSize: '11px', color: palette.textMuted, flexDirection: 'column', alignItems: 'flex-start' }}>
              {rebuild.at ? <span>Rebuilding {rebuild.at}…</span>
                : <span>Rebuilt {rebuild.done.length}{rebuild.failed.length ? `, ${rebuild.failed.length} failed` : ''}</span>}
              {rebuild.failed.map((f) => <span key={f} style={{ color: palette.danger }}>{f}</span>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
