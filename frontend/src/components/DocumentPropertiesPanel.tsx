import { useState, useEffect } from 'react';
import { useDocumentStore } from '@/stores/documentStore';
import { useUIStateStore } from '@/stores/uiStateStore';
import { useThemeStore } from '@/theme';

export function DocumentPropertiesPanel() {
  const propertiesOpen = useUIStateStore((s) => s.propertiesOpen);
  const toggleProperties = useUIStateStore((s) => s.toggleProperties);
  const metadata = useDocumentStore((s) => s.document.metadata);
  const setMetadata = useDocumentStore((s) => s.setMetadata);
  const palette = useThemeStore((s) => s.palette);

  const [description, setDescription] = useState(metadata?.description ?? '');
  const [author, setAuthor] = useState(metadata?.author ?? '');
  const [revision, setRevision] = useState(metadata?.revision ?? '');
  const [notes, setNotes] = useState(metadata?.notes ?? '');

  // Sync local state when document metadata changes externally (e.g. document load)
  useEffect(() => {
    setDescription(metadata?.description ?? '');
    setAuthor(metadata?.author ?? '');
    setRevision(metadata?.revision ?? '');
    setNotes(metadata?.notes ?? '');
  }, [metadata]);

  if (!propertiesOpen) return null;

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '4px 6px',
    border: `1px solid ${palette.inputBorder}`,
    borderRadius: '3px',
    background: palette.inputBg,
    color: palette.text,
    fontSize: '12px',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
    resize: 'vertical',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    color: palette.textMuted,
    marginBottom: '2px',
  };

  return (
    <div
      style={{
        width: '260px',
        flexShrink: 0,
        background: palette.panelBg,
        borderLeft: `1px solid ${palette.border}`,
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 10px',
          borderBottom: `1px solid ${palette.border}`,
        }}
      >
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            color: palette.textMuted,
          }}
        >
          Properties
        </span>
        <button
          onClick={toggleProperties}
          style={{
            background: 'none',
            border: 'none',
            color: palette.textMuted,
            cursor: 'pointer',
            fontSize: '16px',
            lineHeight: 1,
            padding: '0 2px',
          }}
          title="Close properties panel"
        >
          {'\u00d7'}
        </button>
      </div>

      {/* Fields */}
      <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div>
          <div style={labelStyle}>Description</div>
          <textarea
            rows={3}
            style={inputStyle}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => setMetadata({ description })}
          />
        </div>
        <div>
          <div style={labelStyle}>Author</div>
          <input
            type="text"
            style={inputStyle}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            onBlur={() => setMetadata({ author })}
          />
        </div>
        <div>
          <div style={labelStyle}>Revision</div>
          <input
            type="text"
            style={inputStyle}
            value={revision}
            onChange={(e) => setRevision(e.target.value)}
            onBlur={() => setMetadata({ revision })}
          />
        </div>
        <div>
          <div style={labelStyle}>Notes</div>
          <textarea
            rows={4}
            style={inputStyle}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => setMetadata({ notes })}
          />
        </div>
      </div>
    </div>
  );
}
