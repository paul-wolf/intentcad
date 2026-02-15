import { useState } from 'react';
import { useCamStore } from '@/stores/camStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { addLog } from '@/stores/logStore';
import type { CamOperation, CutSide } from '@/types/cam';
import { GcodePreview } from './GcodePreview';

export function CamOperationsPanel() {
  const palette = useThemeStore((s) => s.palette);
  const doc = useDocumentStore((s) => s.document);
  const jobConfig = useCamStore((s) => s.jobConfig);
  const issues = useCamStore((s) => s.issues);
  const generatedGcode = useCamStore((s) => s.generatedGcode);
  const showToolpathPreview = useCamStore((s) => s.showToolpathPreview);
  const updateOperation = useCamStore((s) => s.updateOperation);
  const addOperation = useCamStore((s) => s.addOperation);
  const removeOperation = useCamStore((s) => s.removeOperation);
  const generate = useCamStore((s) => s.generate);
  const downloadGcode = useCamStore((s) => s.downloadGcode);
  const toggleToolpathPreview = useCamStore((s) => s.toggleToolpathPreview);
  const requestAiSuggestion = useCamStore((s) => s.requestAiSuggestion);
  const focusedOperationIndex = useCamStore((s) => s.focusedOperationIndex);
  const setFocusedOperation = useCamStore((s) => s.setFocusedOperation);

  const [showGcodePreview, setShowGcodePreview] = useState(false);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '3px 6px',
    border: `1px solid ${palette.inputBorder}`,
    borderRadius: '3px',
    background: palette.inputBg,
    color: palette.text,
    fontSize: '12px',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '11px',
    color: palette.textMuted,
    marginBottom: '2px',
    display: 'block',
  };

  const sectionStyle: React.CSSProperties = {
    padding: '8px 10px',
    borderBottom: `1px solid ${palette.border}`,
  };

  const headerStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    color: palette.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    marginBottom: '6px',
  };

  const btnStyle: React.CSSProperties = {
    padding: '4px 10px',
    border: `1px solid ${palette.inputBorder}`,
    borderRadius: '3px',
    background: palette.buttonBg,
    color: palette.text,
    cursor: 'pointer',
    fontSize: '11px',
  };

  const primaryBtnStyle: React.CSSProperties = {
    ...btnStyle,
    background: palette.primaryBtn,
    color: '#fff',
    borderColor: palette.primaryBtn,
  };

  const disabledBtn: React.CSSProperties = { ...btnStyle, opacity: 0.4, cursor: 'default' };

  const handleGenerate = () => {
    if (jobConfig.selectedSketchIds.length === 0) {
      addLog('warn', 'Select at least one sketch before generating');
      return;
    }
    const selectedIds = new Set(jobConfig.selectedSketchIds);
    const entities = doc.sketches
      .filter((s) => selectedIds.has(s.id))
      .flatMap((s) => s.entities);
    if (entities.length === 0) {
      addLog('warn', 'Selected sketches contain no entities');
      return;
    }
    generate(entities);
  };

  const handleAiSuggest = () => {
    requestAiSuggestion(
      doc as unknown as Record<string, unknown>,
      jobConfig.profileId ?? undefined,
    );
  };

  const hasSketch = jobConfig.selectedSketchIds.length > 0;

  return (
    <div style={{
      width: '240px',
      background: palette.panelBg,
      borderRight: `1px solid ${palette.border}`,
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
    }}>
      {/* Operations */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Operations</div>
        {jobConfig.operations.map((op, i) => {
          const isFocused = focusedOperationIndex === i;
          const opColor = ['#ff8c00', '#00bcd4', '#8bc34a', '#e91e63', '#9c27b0', '#ff5722'][i % 6]!;
          return (
            <div
              key={i}
              style={{
                marginBottom: '8px',
                padding: '6px',
                border: `1px solid ${isFocused ? opColor : palette.border}`,
                borderRadius: '3px',
                borderLeftWidth: '3px',
                borderLeftColor: opColor,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <select
                  value={op.kind}
                  onChange={(e) => {
                    const kind = e.target.value as 'profile' | 'drill' | 'pocket';
                    let newOp: CamOperation;
                    if (kind === 'profile') {
                      newOp = { kind: 'profile', entityIds: op.entityIds, sketchId: op.sketchId, cutSide: 'on', tabs: false, tabWidth: 5, tabHeight: 1 };
                    } else if (kind === 'drill') {
                      newOp = { kind: 'drill', entityIds: op.entityIds, sketchId: op.sketchId, peckDepth: 0, dwell: 0 };
                    } else {
                      newOp = { kind: 'pocket', entityIds: op.entityIds, sketchId: op.sketchId, stepover: 0.4, cutDirection: 'climb' };
                    }
                    updateOperation(i, newOp);
                  }}
                  style={{ ...inputStyle, width: 'auto' }}
                >
                  <option value="profile">2D Contour</option>
                  <option value="drill">Drill</option>
                  <option value="pocket">Pocket</option>
                </select>
                <button onClick={() => removeOperation(i)} style={{ ...btnStyle, color: palette.danger, borderColor: palette.danger }}>
                  X
                </button>
              </div>

              {/* Entity assignment */}
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginBottom: '4px' }}>
                <button
                  onClick={() => setFocusedOperation(isFocused ? null : i)}
                  style={{
                    ...btnStyle,
                    borderColor: isFocused ? opColor : palette.inputBorder,
                    color: isFocused ? opColor : palette.text,
                    fontSize: '10px',
                    flex: 1,
                  }}
                >
                  {isFocused ? 'Click entities on canvas...' : 'Select Entities'}
                </button>
              </div>
              {/* Smart selection buttons */}
              <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap', marginBottom: '4px' }}>
                {op.kind === 'profile' && (
                  <button
                    onClick={() => {
                      const selectedSketchIds = new Set(jobConfig.selectedSketchIds);
                      const closedIds: string[] = [];
                      for (const sketch of doc.sketches) {
                        if (!selectedSketchIds.has(sketch.id)) continue;
                        for (const e of sketch.entities) {
                          if ('construction' in e && e.construction) continue;
                          if (e.type === 'line' && e.closed) closedIds.push(e.id);
                          if (e.type === 'circle') closedIds.push(e.id);
                          if (e.type === 'rectangle') closedIds.push(e.id);
                        }
                      }
                      if (closedIds.length > 0) {
                        updateOperation(i, { entityIds: closedIds });
                      }
                    }}
                    style={{ ...btnStyle, fontSize: '9px', padding: '2px 6px' }}
                  >
                    All Closed
                  </button>
                )}
                {op.kind === 'drill' && (
                  <button
                    onClick={() => {
                      const toolDia = jobConfig.tool.diameter;
                      const tolerance = 0.05;
                      const selectedSketchIds = new Set(jobConfig.selectedSketchIds);
                      const holeIds: string[] = [];
                      for (const sketch of doc.sketches) {
                        if (!selectedSketchIds.has(sketch.id)) continue;
                        for (const e of sketch.entities) {
                          if (e.type !== 'circle') continue;
                          if ('construction' in e && e.construction) continue;
                          if (Math.abs(e.radius * 2 - toolDia) <= tolerance) {
                            holeIds.push(e.id);
                          }
                        }
                      }
                      if (holeIds.length > 0) {
                        updateOperation(i, { entityIds: holeIds });
                      }
                    }}
                    style={{ ...btnStyle, fontSize: '9px', padding: '2px 6px' }}
                  >
                    {`Match \u00D8${jobConfig.tool.diameter}`}
                  </button>
                )}
                {op.kind === 'drill' && (
                  <button
                    onClick={() => {
                      const toolDia = jobConfig.tool.diameter;
                      const selectedSketchIds = new Set(jobConfig.selectedSketchIds);
                      const holeIds: string[] = [];
                      for (const sketch of doc.sketches) {
                        if (!selectedSketchIds.has(sketch.id)) continue;
                        for (const e of sketch.entities) {
                          if (e.type !== 'circle') continue;
                          if ('construction' in e && e.construction) continue;
                          if (e.radius * 2 <= toolDia) {
                            holeIds.push(e.id);
                          }
                        }
                      }
                      if (holeIds.length > 0) {
                        updateOperation(i, { entityIds: holeIds });
                      }
                    }}
                    style={{ ...btnStyle, fontSize: '9px', padding: '2px 6px' }}
                  >
                    {`All \u2264\u00D8${jobConfig.tool.diameter}`}
                  </button>
                )}
                <button
                  onClick={() => {
                    const selectedSketchIds = new Set(jobConfig.selectedSketchIds);
                    const allIds: string[] = [];
                    for (const sketch of doc.sketches) {
                      if (!selectedSketchIds.has(sketch.id)) continue;
                      for (const e of sketch.entities) {
                        if (e.type === 'dimension') continue;
                        if (e.type === 'point') continue;
                        if ('construction' in e && e.construction) continue;
                        allIds.push(e.id);
                      }
                    }
                    if (allIds.length > 0) {
                      updateOperation(i, { entityIds: allIds });
                    }
                  }}
                  style={{ ...btnStyle, fontSize: '9px', padding: '2px 6px' }}
                >
                  All
                </button>
              </div>
              <div style={{ fontSize: '10px', color: palette.textMuted, marginBottom: '4px' }}>
                {op.entityIds.length} entit{op.entityIds.length === 1 ? 'y' : 'ies'}
                {op.entityIds.length > 0 && (
                  <button
                    onClick={() => updateOperation(i, { entityIds: [] })}
                    style={{ border: 'none', background: 'none', color: palette.danger, cursor: 'pointer', fontSize: '10px', marginLeft: '4px' }}
                  >
                    clear
                  </button>
                )}
              </div>

              {op.kind === 'profile' && (
                <>
                  <label style={labelStyle}>Cut Side</label>
                  <select
                    value={op.cutSide}
                    onChange={(e) => updateOperation(i, { cutSide: e.target.value as CutSide })}
                    style={inputStyle}
                  >
                    <option value="on">On Line</option>
                    <option value="inside">Inside</option>
                    <option value="outside">Outside</option>
                  </select>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                    <input
                      type="checkbox"
                      checked={op.tabs}
                      onChange={(e) => updateOperation(i, { tabs: e.target.checked })}
                    />
                    Tabs
                  </label>
                </>
              )}

              {op.kind === 'drill' && (
                <>
                  <label style={labelStyle}>Peck Depth (mm, 0=single)</label>
                  <input
                    type="number"
                    value={op.peckDepth}
                    onChange={(e) => updateOperation(i, { peckDepth: +e.target.value })}
                    style={inputStyle}
                    min={0}
                    step={0.5}
                  />
                  <label style={labelStyle}>Dwell (seconds)</label>
                  <input
                    type="number"
                    value={op.dwell}
                    onChange={(e) => updateOperation(i, { dwell: +e.target.value })}
                    style={inputStyle}
                    min={0}
                    step={0.5}
                  />
                </>
              )}

              {op.kind === 'pocket' && (
                <>
                  <label style={labelStyle}>Stepover (fraction)</label>
                  <input
                    type="number"
                    value={op.stepover}
                    onChange={(e) => updateOperation(i, { stepover: +e.target.value })}
                    style={inputStyle}
                    min={0.1}
                    max={1}
                    step={0.05}
                  />
                  <label style={labelStyle}>Direction</label>
                  <select
                    value={op.cutDirection}
                    onChange={(e) => updateOperation(i, { cutDirection: e.target.value as 'climb' | 'conventional' })}
                    style={inputStyle}
                  >
                    <option value="climb">Climb</option>
                    <option value="conventional">Conventional</option>
                  </select>
                </>
              )}
            </div>
          );
        })}
        <button
          onClick={() => {
            if (!hasSketch) {
              addLog('warn', 'Select at least one sketch before adding operations');
              return;
            }
            addOperation({
              kind: 'profile',
              entityIds: [],
              sketchId: jobConfig.selectedSketchIds[0]!,
              cutSide: 'on',
              tabs: false,
              tabWidth: 5,
              tabHeight: 1,
            });
          }}
          style={hasSketch ? btnStyle : disabledBtn}
          disabled={!hasSketch}
        >
          + Add Operation
        </button>
      </div>

      {/* Issues */}
      {issues.length > 0 && (
        <div style={sectionStyle}>
          <div style={headerStyle}>Issues</div>
          {issues.map((issue, i) => (
            <div
              key={i}
              style={{
                fontSize: '11px',
                padding: '3px 6px',
                marginBottom: '2px',
                borderRadius: '2px',
                color: issue.severity === 'error' ? palette.danger : issue.severity === 'warning' ? palette.warning : palette.accent,
                background: issue.severity === 'error' ? palette.danger + '15' : issue.severity === 'warning' ? palette.warning + '15' : palette.accent + '15',
              }}
            >
              {issue.severity.toUpperCase()}: {issue.message}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div style={{ ...sectionStyle, display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={headerStyle}>Actions</div>
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          <button onClick={handleGenerate} style={primaryBtnStyle}>Generate</button>
          <button
            onClick={generatedGcode ? downloadGcode : undefined}
            style={generatedGcode ? btnStyle : disabledBtn}
            disabled={!generatedGcode}
          >Download .nc</button>
          <button
            onClick={generatedGcode ? () => setShowGcodePreview(!showGcodePreview) : undefined}
            style={generatedGcode ? btnStyle : disabledBtn}
            disabled={!generatedGcode}
          >
            {showGcodePreview ? 'Hide G-code' : 'View G-code'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          <button onClick={toggleToolpathPreview} style={{
            ...btnStyle,
            borderColor: showToolpathPreview ? palette.accent : palette.inputBorder,
            color: showToolpathPreview ? palette.accent : palette.text,
          }}>
            {showToolpathPreview ? 'Hide Preview' : 'Show Preview'}
          </button>
          <button onClick={handleAiSuggest} style={btnStyle}>AI Suggest</button>
        </div>
      </div>

      {/* G-code Preview */}
      {showGcodePreview && generatedGcode && (
        <GcodePreview gcode={generatedGcode} onClose={() => setShowGcodePreview(false)} />
      )}
    </div>
  );
}
