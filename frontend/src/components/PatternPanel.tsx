import { useMemo } from 'react';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { describePattern, patternsOf } from '@/utils/copyPattern';
import { editPattern } from '@/tools/openCopyDialog';
import { requestSave } from '@/api/autoSave';
import type { CopyPattern } from '@/types/document';

/** The grid and circular copies the selection belongs to, each with a way
 *  back into its dialog to change it. */
export function PatternPanel() {
  const palette = useThemeStore((s) => s.palette);
  const selectedEntityIds = useEditorStore((s) => s.selectedEntityIds);
  const dialogOpen = useEditorStore((s) => !!s.gridCopyEntityIds || !!s.circularCopyEntityIds);
  const patterns = useDocumentStore((s) => s.document.sketches.find((sk) => sk.id === s.document.activeSketchId)?.patterns);
  const touched = useMemo(() => patternsOf(patterns, selectedEntityIds), [patterns, selectedEntityIds]);
  if (touched.length === 0) return null;

  // the copies go, the originals stay
  const deleteCopies = (p: CopyPattern) => {
    const ds = useDocumentStore.getState();
    ds.beginTransaction(p.kind === 'grid' ? 'Delete grid copies' : 'Delete circular copies');
    ds.removeEntities(p.copyIds);
    useEditorStore.getState().setSelectedEntityIds(new Set(p.sourceIds));
    requestSave();
  };

  const btn: React.CSSProperties = {
    padding: '3px 10px', fontSize: '11px', borderRadius: '3px',
    border: `1px solid ${palette.inputBorder}`, background: palette.buttonBg, color: palette.text,
    cursor: dialogOpen ? 'default' : 'pointer', opacity: dialogOpen ? 0.5 : 1,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', borderBottom: `1px solid ${palette.border}` }}>
      <div style={{ padding: '8px 10px', borderBottom: `1px solid ${palette.border}` }}>
        <span style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px',
                       color: palette.textMuted }}>
          Pattern
        </span>
      </div>
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {touched.map((p) => {
          const label = p.kind === 'grid' ? 'grid copy' : 'circular copy';
          return (
            <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ fontSize: '11px', color: palette.text }}>
                {describePattern(p)}
                <span style={{ color: palette.textMuted }}>
                  {' '}· {p.copyIds.length} cop{p.copyIds.length === 1 ? 'y' : 'ies'} of {p.sourceIds.length} shape{p.sourceIds.length === 1 ? '' : 's'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  onClick={() => editPattern(p)}
                  disabled={dialogOpen}
                  title={`Reopen the ${label} with its settings: change them and Update replaces the copies`}
                  style={btn}
                >
                  Edit {label}…
                </button>
                <button
                  onClick={() => deleteCopies(p)}
                  disabled={dialogOpen}
                  title="Delete these copies, keeping the originals"
                  style={btn}
                >
                  Delete copies
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
