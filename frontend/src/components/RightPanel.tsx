import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { PropertiesPanel } from './PropertiesPanel';
import { SketchPanel } from './SketchPanel';
import { ParametersPanel } from './ParametersPanel';
import { PatternPanel } from './PatternPanel';
import { SharedSketchPanel } from './SharedSketchPanel';

export function RightPanel() {
  const selectedEntityIds = useEditorStore((s) => s.selectedEntityIds);
  const sketch = useDocumentStore((s) => s.getActiveSketch());
  const palette = useThemeStore((s) => s.palette);

  let singleEntity = undefined;
  if (selectedEntityIds.size === 1 && sketch) {
    const id = [...selectedEntityIds][0]!;
    singleEntity = sketch.entities.find((e) => e.id === id);
  }

  return (
    <div
      style={{
        width: '240px',
        background: palette.panelBg,
        borderLeft: `1px solid ${palette.border}`,
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
      }}
    >
      <SketchPanel />
      <SharedSketchPanel />
      <ParametersPanel />
      <PatternPanel />
      {singleEntity && <PropertiesPanel entity={singleEntity} />}
    </div>
  );
}
