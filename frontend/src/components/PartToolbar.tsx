import { useNavigate } from 'react-router-dom';
import { usePartStore } from '@/stores/partStore';
import { useThemeStore } from '@/theme';

interface PartToolbarProps {
  onAddExtrude: () => void;
  onAddRevolve: () => void;
  onAddShell: () => void;
  onAddFillet: () => void;
  onAddChamfer: () => void;
  onAddLoft: () => void;
  onExportSTL: () => void;
  onExportSTEP: () => void;
}

export function PartToolbar({ onAddExtrude, onAddRevolve, onAddShell, onAddFillet, onAddChamfer, onAddLoft, onExportSTL, onExportSTEP }: PartToolbarProps) {
  const navigate = useNavigate();
  const part = usePartStore((s) => s.part);
  const setPartName = usePartStore((s) => s.setPartName);
  const beginTransaction = usePartStore((s) => s.beginTransaction);
  const undo = usePartStore((s) => s.undo);
  const redo = usePartStore((s) => s.redo);
  const palette = useThemeStore((s) => s.palette);
  const buttonStyle: React.CSSProperties = {
    padding: '4px 12px',
    background: palette.buttonBg,
    color: palette.text,
    border: `1px solid ${palette.border}`,
    borderRadius: '4px',
    fontSize: '13px',
    cursor: 'pointer',
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 12px',
        background: palette.panelBg,
        borderBottom: `1px solid ${palette.border}`,
      }}
    >
      <button style={buttonStyle} onClick={() => navigate('/')}>
        Home
      </button>
      <button style={buttonStyle} onClick={() => {
        if (part.documentId) {
          navigate(`/edit/${part.documentId}`);
        } else {
          navigate('/');
        }
      }}>
        Back to Sketch
      </button>

      <input
        style={{
          background: palette.inputBg,
          color: palette.text,
          border: `1px solid ${palette.inputBorder}`,
          borderRadius: '4px',
          padding: '4px 8px',
          fontSize: '14px',
          fontWeight: 600,
          width: '180px',
        }}
        value={part.name}
        onChange={(e) => {
          beginTransaction('Rename part');
          setPartName(e.target.value);
        }}
      />

      <div style={{ flex: 1 }} />

      <button style={buttonStyle} onClick={undo}>
        Undo
      </button>
      <button style={buttonStyle} onClick={redo}>
        Redo
      </button>

      <div style={{ width: '1px', height: '20px', background: palette.border }} />

      <button
        style={{ ...buttonStyle, background: palette.primaryBtn, color: '#fff', border: 'none' }}
        onClick={onAddExtrude}
      >
        Extrude
      </button>
      <button
        style={{ ...buttonStyle, background: palette.primaryBtn, color: '#fff', border: 'none' }}
        onClick={onAddRevolve}
      >
        Revolve
      </button>
      <button
        style={{ ...buttonStyle, background: palette.primaryBtn, color: '#fff', border: 'none' }}
        onClick={onAddShell}
      >
        Shell
      </button>
      <button
        style={{ ...buttonStyle, background: palette.primaryBtn, color: '#fff', border: 'none' }}
        onClick={onAddFillet}
      >
        Fillet
      </button>
      <button
        style={{ ...buttonStyle, background: palette.primaryBtn, color: '#fff', border: 'none' }}
        onClick={onAddChamfer}
      >
        Chamfer
      </button>
      <button
        style={{ ...buttonStyle, background: palette.primaryBtn, color: '#fff', border: 'none' }}
        onClick={onAddLoft}
      >
        Loft
      </button>
      <button style={buttonStyle} onClick={onExportSTL}>
        Export STL
      </button>
      <button style={buttonStyle} onClick={onExportSTEP}>
        Export STEP
      </button>
    </div>
  );
}
