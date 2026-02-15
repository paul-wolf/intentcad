import { useThemeStore } from '@/theme';

interface GcodePreviewProps {
  gcode: string;
  onClose: () => void;
}

export function GcodePreview({ gcode, onClose }: GcodePreviewProps) {
  const palette = useThemeStore((s) => s.palette);
  const lineCount = gcode.split('\n').length;

  const handleCopy = () => {
    navigator.clipboard.writeText(gcode);
  };

  return (
    <div style={{
      padding: '8px 10px',
      borderBottom: `1px solid ${palette.border}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
        <span style={{ fontSize: '11px', color: palette.textMuted }}>{lineCount} lines</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={handleCopy}
            style={{
              padding: '2px 8px',
              border: `1px solid ${palette.inputBorder}`,
              borderRadius: '3px',
              background: palette.buttonBg,
              color: palette.text,
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Copy
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '2px 8px',
              border: `1px solid ${palette.inputBorder}`,
              borderRadius: '3px',
              background: palette.buttonBg,
              color: palette.text,
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Close
          </button>
        </div>
      </div>
      <pre style={{
        maxHeight: '300px',
        overflowY: 'auto',
        fontSize: '10px',
        lineHeight: 1.4,
        fontFamily: 'monospace',
        color: palette.text,
        background: palette.inputBg,
        border: `1px solid ${palette.border}`,
        borderRadius: '3px',
        padding: '6px',
        margin: 0,
        whiteSpace: 'pre',
        tabSize: 4,
      }}>
        {gcode}
      </pre>
    </div>
  );
}
