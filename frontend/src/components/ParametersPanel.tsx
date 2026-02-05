import { useState } from 'react';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { requestSave } from '@/api/autoSave';
import { NumberInput } from './NumberInput';
import { isValidParamName } from '@/utils/expression';

export function ParametersPanel() {
  const palette = useThemeStore((s) => s.palette);

  const parameters = useDocumentStore((s) => s.document.parameters ?? {});
  const beginTransaction = useDocumentStore((s) => s.beginTransaction);
  const setParameter = useDocumentStore((s) => s.setParameter);
  const removeParameter = useDocumentStore((s) => s.removeParameter);
  const renameParameter = useDocumentStore((s) => s.renameParameter);

  const [editingParamName, setEditingParamName] = useState<string | null>(null);
  const [editParamNameValue, setEditParamNameValue] = useState('');
  const [hoveredParam, setHoveredParam] = useState<string | null>(null);

  const addParameter = () => {
    const existing = Object.keys(parameters);
    let idx = 1;
    while (existing.includes(`param${idx}`)) idx++;
    beginTransaction('Add parameter');
    setParameter(`param${idx}`, 10);
    requestSave();
  };

  const commitParamRename = () => {
    if (editingParamName && editParamNameValue.trim()) {
      const newName = editParamNameValue.trim();
      if (isValidParamName(newName) && newName !== editingParamName && !(newName in parameters)) {
        beginTransaction('Rename parameter');
        renameParameter(editingParamName, newName);
        requestSave();
      }
    }
    setEditingParamName(null);
  };

  const paramEntries = Object.entries(parameters);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderBottom: `1px solid ${palette.border}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
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
          Parameters
        </span>
        <button
          style={{
            background: 'none',
            border: `1px solid ${palette.inputBorder}`,
            borderRadius: '3px',
            color: palette.textMuted,
            cursor: 'pointer',
            fontSize: '14px',
            width: '22px',
            height: '22px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={addParameter}
          title="Add parameter"
        >
          +
        </button>
      </div>

      {/* Parameter list */}
      <div style={{ overflowY: 'auto', maxHeight: '150px' }}>
        {paramEntries.length === 0 && (
          <div style={{ padding: '8px 10px', fontSize: '11px', color: palette.textMuted, fontStyle: 'italic' }}>
            No parameters
          </div>
        )}
        {paramEntries.map(([name, value]) => (
          <div
            key={name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 10px',
              fontSize: '12px',
            }}
            onMouseEnter={() => setHoveredParam(name)}
            onMouseLeave={() => setHoveredParam(null)}
          >
            {editingParamName === name ? (
              <input
                style={{
                  width: '55px',
                  flexShrink: 0,
                  background: palette.inputBg,
                  border: `1px solid ${palette.inputBorder}`,
                  borderRadius: '2px',
                  color: palette.text,
                  fontSize: '11px',
                  fontFamily: 'monospace',
                  padding: '1px 4px',
                  outline: 'none',
                }}
                value={editParamNameValue}
                onChange={(e) => setEditParamNameValue(e.target.value)}
                onBlur={commitParamRename}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitParamRename();
                  if (e.key === 'Escape') setEditingParamName(null);
                }}
                autoFocus
              />
            ) : (
              <span
                style={{
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  color: palette.text,
                  cursor: 'default',
                  flexShrink: 0,
                  maxWidth: '55px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                onDoubleClick={() => {
                  setEditingParamName(name);
                  setEditParamNameValue(name);
                }}
                title={name}
              >
                {name}
              </span>
            )}
            <span style={{ color: palette.textMuted, flexShrink: 0 }}>=</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <NumberInput
                value={value}
                onChange={(v) => {
                  beginTransaction('Edit parameter');
                  setParameter(name, v);
                  requestSave();
                }}
              />
            </div>
            {hoveredParam === name && (
              <button
                style={{
                  background: 'none',
                  border: 'none',
                  color: palette.textMuted,
                  cursor: 'pointer',
                  fontSize: '12px',
                  padding: 0,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
                onClick={() => {
                  beginTransaction('Delete parameter');
                  removeParameter(name);
                  requestSave();
                }}
                title="Delete parameter"
              >
                x
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
