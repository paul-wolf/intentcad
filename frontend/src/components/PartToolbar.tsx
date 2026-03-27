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
  onAddPlane: () => void;
  onSketchOnFace: () => void;
  onExportSTL: () => void;
  onExportSTEP: () => void;
  disabled?: boolean;
}

export function PartToolbar({ onAddExtrude, onAddRevolve, onAddShell, onAddFillet, onAddChamfer, onAddLoft, onAddPlane, onSketchOnFace, onExportSTL, onExportSTEP, disabled }: PartToolbarProps) {
  const navigate = useNavigate();
  const part = usePartStore((s) => s.part);
  const setPartName = usePartStore((s) => s.setPartName);
  const beginTransaction = usePartStore((s) => s.beginTransaction);
  const undo = usePartStore((s) => s.undo);
  const redo = usePartStore((s) => s.redo);
  const palette = useThemeStore((s) => s.palette);
  const buttonStyle: React.CSSProperties = {
    padding: '4px 10px',
    background: palette.buttonBg,
    color: palette.text,
    border: `1px solid ${palette.border}`,
    borderRadius: '4px',
    fontSize: '12px',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    pointerEvents: disabled ? 'none' : 'auto',
  };

  const primaryStyle: React.CSSProperties = {
    ...buttonStyle,
    background: palette.primaryBtn,
    color: '#fff',
    border: 'none',
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 12px',
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: palette.panelBg,
        borderBottom: `1px solid ${palette.border}`,
      }}
    >
      {/* Row 1: Navigation, name, undo/redo */}
      <div style={rowStyle}>
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
            padding: '3px 8px',
            fontSize: '13px',
            fontWeight: 600,
            width: '160px',
          }}
          value={part.name}
          onChange={(e) => {
            beginTransaction('Rename part');
            setPartName(e.target.value);
          }}
        />

        <div style={{ flex: 1 }} />

        <button style={buttonStyle} onClick={undo}>Undo</button>
        <button style={buttonStyle} onClick={redo}>Redo</button>

        <div style={{ width: '1px', height: '18px', background: palette.border }} />

        <button style={buttonStyle} onClick={onExportSTL}>STL</button>
        <button style={buttonStyle} onClick={onExportSTEP}>STEP</button>
      </div>

      {/* Row 2: Features + sketch actions */}
      <div style={{ ...rowStyle, borderTop: `1px solid ${palette.border}` }}>
        <span style={{ fontSize: '11px', color: palette.textSecondary, marginRight: '2px' }}>Create:</span>

        <button style={primaryStyle} onClick={onAddPlane}>Plane</button>

        <div style={{ width: '1px', height: '18px', background: palette.border }} />

        <button style={primaryStyle} onClick={onSketchOnFace}>Sketch on Face</button>

        <div style={{ width: '1px', height: '18px', background: palette.border }} />

        <button style={primaryStyle} onClick={onAddExtrude}>Extrude</button>
        <button style={primaryStyle} onClick={onAddRevolve}>Revolve</button>
        <button style={primaryStyle} onClick={onAddLoft}>Loft</button>

        <div style={{ width: '1px', height: '18px', background: palette.border }} />

        <button style={primaryStyle} onClick={onAddShell}>Shell</button>
        <button style={primaryStyle} onClick={onAddFillet}>Fillet</button>
        <button style={primaryStyle} onClick={onAddChamfer}>Chamfer</button>
      </div>
    </div>
  );
}
