import { usePartStore } from '@/stores/partStore';
import { usePartEditorStore } from '@/stores/partEditorStore';
import { useThemeStore } from '@/theme';
import type { Feature } from '@/types/part';

interface FeaturePanelProps {
  onEditFeature: (feature: Feature) => void;
}

export function FeaturePanel({ onEditFeature }: FeaturePanelProps) {
  const features = usePartStore((s) => s.part.features);
  const beginTransaction = usePartStore((s) => s.beginTransaction);
  const removeFeature = usePartStore((s) => s.removeFeature);
  const selectedFeatureId = usePartEditorStore((s) => s.selectedFeatureId);
  const setSelectedFeatureId = usePartEditorStore((s) => s.setSelectedFeatureId);
  const palette = useThemeStore((s) => s.palette);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          fontSize: '13px',
          fontWeight: 600,
          color: palette.text,
          borderBottom: `1px solid ${palette.border}`,
        }}
      >
        Features
      </div>

      {features.length === 0 && (
        <div style={{ padding: '12px', fontSize: '12px', color: palette.textSecondary }}>
          No features yet. Click "Add Extrude" to begin.
        </div>
      )}

      {features.map((f) => (
        <div
          key={f.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 12px',
            cursor: 'pointer',
            background: selectedFeatureId === f.id ? palette.activeItemBg : 'transparent',
            borderBottom: `1px solid ${palette.border}`,
          }}
          onClick={() => setSelectedFeatureId(f.id)}
          onDoubleClick={() => onEditFeature(f)}
        >
          <span style={{ fontSize: '12px', color: palette.accent }}>
            {f.type === 'extrude' ? 'E' : '?'}
          </span>
          <span style={{ flex: 1, fontSize: '12px', color: palette.text }}>
            {f.operation === 'remove' ? 'Cut' : 'Extrude'} {f.distance}mm
          </span>
          <button
            style={{
              background: 'none',
              border: 'none',
              color: palette.danger,
              cursor: 'pointer',
              fontSize: '13px',
              padding: '0 2px',
            }}
            onClick={(e) => {
              e.stopPropagation();
              beginTransaction('Remove feature');
              removeFeature(f.id);
            }}
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}
