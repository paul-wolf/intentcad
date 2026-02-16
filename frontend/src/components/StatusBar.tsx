import { useMemo } from 'react';
import { useEditorStore } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { computeSketchDoF, sketchTotalDoF } from '@/utils/dof';
import { getProjectName } from '@/api/autoSave';

export function StatusBar() {
  const cursorWorld = useEditorStore((s) => s.cursorWorld);
  const activeTool = useEditorStore((s) => s.activeTool);
  const viewportScale = useEditorStore((s) => s.viewportScale);
  const docName = useDocumentStore((s) => s.document.name);
  const palette = useThemeStore((s) => s.palette);
  const activeSketch = useDocumentStore((s) => {
    const doc = s.document;
    return doc.sketches.find((sk) => sk.id === doc.activeSketchId);
  });

  const totalDoF = useMemo(() => {
    if (!activeSketch) return null;
    const dofMap = computeSketchDoF(activeSketch.entities, activeSketch.constraints);
    return sketchTotalDoF(dofMap);
  }, [activeSketch]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '4px 10px',
        background: palette.panelBg,
        borderTop: `1px solid ${palette.border}`,
        fontSize: '12px',
        color: palette.textMuted,
        fontFamily: 'monospace',
      }}
    >
      {getProjectName() && (
        <>
          <span>{getProjectName()}</span>
          <span style={{ color: palette.inputBorder }}>/</span>
        </>
      )}
      <span>{docName}</span>
      <span style={{ color: palette.inputBorder }}>|</span>
      <span>Tool: {activeTool}</span>
      <span style={{ color: palette.inputBorder }}>|</span>
      <span>
        {cursorWorld
          ? `${cursorWorld.x.toFixed(1)} , ${cursorWorld.y.toFixed(1)} mm`
          : '— , — mm'}
      </span>
      <span style={{ color: palette.inputBorder }}>|</span>
      <span>{viewportScale.toFixed(1)}x</span>
      {totalDoF !== null && (
        <>
          <span style={{ color: palette.inputBorder }}>|</span>
          <span style={{ color: totalDoF === 0 ? palette.constrained : undefined }}>
            DoF: {totalDoF}
          </span>
        </>
      )}
    </div>
  );
}
