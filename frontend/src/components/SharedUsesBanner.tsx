/**
 * Over the sketch editor's drawing: a held save that would drop a group or
 * named element some part uses (api/sharedUses.ts), the parts it would
 * break, and Save anyway / Undo.
 */
import { useSyncExternalStore } from 'react';
import { useThemeStore } from '@/theme';
import { useDocumentStore } from '@/stores/documentStore';
import { dropHeld, getHeld, saveAnyway, subscribeSharedUses } from '@/api/sharedUses';

export function SharedUsesBanner() {
  const palette = useThemeStore((s) => s.palette);
  const held = useSyncExternalStore(subscribeSharedUses, getHeld);
  if (!held) return null;
  const btn: React.CSSProperties = {
    background: 'none', border: `1px solid ${palette.inputBorder}`, borderRadius: '4px',
    color: palette.text, cursor: 'pointer', fontSize: '12px', padding: '3px 10px',
  };
  return (
    <div role="alert"
         style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 6,
                  maxWidth: '560px', padding: '8px 12px', background: palette.panelBg,
                  border: `1px solid ${palette.warning}`, borderRadius: '6px', fontSize: '12px',
                  color: palette.textMuted, boxShadow: '0 2px 8px rgba(0,0,0,0.25)' }}>
      <div style={{ color: palette.text, fontWeight: 600, marginBottom: '4px' }}>
        Not saved yet: this change would break {held.breaks.length === 1 ? 'a part' : `${held.breaks.length} parts`} that use this sketch
      </div>
      <ul style={{ margin: '0 0 8px 16px', padding: 0 }}>
        {held.breaks.map((b) => (
          <li key={b.part}><b style={{ color: palette.text }}>{b.part}</b> uses {b.missing.join(', ')}</li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button style={btn} onClick={() => { dropHeld(); useDocumentStore.getState().undo(); }}
                title="Undo the change (the sketch stays as the parts expect)">Undo</button>
        <button style={{ ...btn, borderColor: palette.warning, color: palette.warning }} onClick={saveAnyway}
                title="Save it: those parts fail on their next build until their scripts are changed">Save anyway</button>
      </div>
    </div>
  );
}
