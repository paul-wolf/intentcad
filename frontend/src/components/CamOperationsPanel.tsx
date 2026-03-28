import { useState } from 'react';
import { useCamStore } from '@/stores/camStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { addLog } from '@/stores/logStore';
import type { CutSide } from '@/types/cam';
import { GcodePreview } from './GcodePreview';

export function CamOperationsPanel({ onShowCutting }: { onShowCutting?: () => void }) {
  const palette = useThemeStore((s) => s.palette);
  const doc = useDocumentStore((s) => s.document);
  const jobConfig = useCamStore((s) => s.jobConfig);
  const issues = useCamStore((s) => s.issues);
  const generatedGcode = useCamStore((s) => s.generatedGcode);
  const showToolpathPreview = useCamStore((s) => s.showToolpathPreview);
  const updateOperation = useCamStore((s) => s.updateOperation);
  const addOperation = useCamStore((s) => s.addOperation);
  const removeOperation = useCamStore((s) => s.removeOperation);
  const moveOperation = useCamStore((s) => s.moveOperation);
  const generate = useCamStore((s) => s.generate);
  const downloadGcode = useCamStore((s) => s.downloadGcode);
  const toggleToolpathPreview = useCamStore((s) => s.toggleToolpathPreview);
  const requestAiSuggestion = useCamStore((s) => s.requestAiSuggestion);
  const focusedOperationIndex = useCamStore((s) => s.focusedOperationIndex);
  const setFocusedOperation = useCamStore((s) => s.setFocusedOperation);
  const toolpath = useCamStore((s) => s.toolpath);
  const simState = useCamStore((s) => s.simState);
  const simSpeed = useCamStore((s) => s.simSpeed);
  const simPlay = useCamStore((s) => s.simPlay);
  const simPause = useCamStore((s) => s.simPause);
  const simStop = useCamStore((s) => s.simStop);
  const simStep = useCamStore((s) => s.simStep);
  const simSetSpeed = useCamStore((s) => s.simSetSpeed);

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
    setShowGcodePreview(true);
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
                    const kind = e.target.value as 'profile' | 'drill' | 'pocket' | 'facing';
                    const base = { entityIds: op.entityIds, sketchId: op.sketchId, cutting: op.cutting };
                    if (kind === 'profile') {
                      updateOperation(i, { ...base, kind: 'profile', cutSide: 'on', tabs: false, tabWidth: 5, tabHeight: 1 });
                    } else if (kind === 'drill') {
                      updateOperation(i, { ...base, kind: 'drill', peckDepth: 0, dwell: 0 });
                    } else if (kind === 'facing') {
                      updateOperation(i, { ...base, kind: 'facing', stepover: 0.7, cutDirection: 'climb' });
                    } else {
                      updateOperation(i, { ...base, kind: 'pocket', stepover: 0.4, cutDirection: 'climb' });
                    }
                  }}
                  style={{ ...inputStyle, width: 'auto' }}
                >
                  <option value="facing">Facing</option>
                  <option value="profile">2D Contour</option>
                  <option value="drill">Drill</option>
                  <option value="pocket">Pocket</option>
                </select>
                <div style={{ display: 'flex', gap: '2px' }}>
                  <button
                    onClick={() => moveOperation(i, -1)}
                    style={{ ...btnStyle, padding: '2px 5px', fontSize: '10px', opacity: i === 0 ? 0.3 : 1 }}
                    disabled={i === 0}
                    title="Move up"
                  >&#9650;</button>
                  <button
                    onClick={() => moveOperation(i, 1)}
                    style={{ ...btnStyle, padding: '2px 5px', fontSize: '10px', opacity: i === jobConfig.operations.length - 1 ? 0.3 : 1 }}
                    disabled={i === jobConfig.operations.length - 1}
                    title="Move down"
                  >&#9660;</button>
                  <button onClick={() => removeOperation(i)} style={{ ...btnStyle, color: palette.danger, borderColor: palette.danger }}>
                    X
                  </button>
                </div>
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
                {op.kind === 'profile' && (
                  <button
                    onClick={() => {
                      const toolDia = op.cutting.tool.diameter;
                      const selectedSketchIds = new Set(jobConfig.selectedSketchIds);
                      const holeIds: string[] = [];
                      for (const sketch of doc.sketches) {
                        if (!selectedSketchIds.has(sketch.id)) continue;
                        for (const e of sketch.entities) {
                          if (e.type !== 'circle') continue;
                          if ('construction' in e && e.construction) continue;
                          // Tool must fit inside the hole with clearance
                          if (e.radius * 2 > toolDia) {
                            holeIds.push(e.id);
                          }
                        }
                      }
                      if (holeIds.length > 0) {
                        updateOperation(i, { entityIds: holeIds });
                      } else {
                        addLog('info', `No circles larger than tool \u00D8${toolDia}mm`);
                      }
                    }}
                    style={{ ...btnStyle, fontSize: '9px', padding: '2px 6px' }}
                  >
                    {`Holes > \u00D8${op.cutting.tool.diameter}`}
                  </button>
                )}
                {op.kind === 'drill' && (
                  <button
                    onClick={() => {
                      const toolDia = op.cutting.tool.diameter;
                      const selectedSketchIds = new Set(jobConfig.selectedSketchIds);
                      const holeIds: string[] = [];
                      const diametersFound = new Map<string, number>();
                      for (const sketch of doc.sketches) {
                        if (!selectedSketchIds.has(sketch.id)) continue;
                        for (const e of sketch.entities) {
                          if (e.type !== 'circle') continue;
                          if ('construction' in e && e.construction) continue;
                          const dia = e.radius * 2;
                          const key = dia.toFixed(2);
                          diametersFound.set(key, (diametersFound.get(key) ?? 0) + 1);
                          // Match within 5% of tool diameter
                          if (Math.abs(dia - toolDia) <= toolDia * 0.05) {
                            holeIds.push(e.id);
                          }
                        }
                      }
                      if (holeIds.length > 0) {
                        updateOperation(i, { entityIds: holeIds });
                        addLog('info', `Selected ${holeIds.length} hole(s) matching \u00D8${toolDia}mm`);
                      } else {
                        const found = diametersFound.size > 0
                          ? ` (found: ${[...diametersFound.entries()].map(([d, n]) => `${n}\u00D7\u00D8${d}`).join(', ')})`
                          : ' (no circles in selected sketches)';
                        addLog('info', `No circles matching tool \u00D8${toolDia}mm${found}`);
                      }
                    }}
                    style={{ ...btnStyle, fontSize: '9px', padding: '2px 6px' }}
                  >
                    {`Match \u00D8${op.cutting.tool.diameter}`}
                  </button>
                )}
                {op.kind === 'drill' && (
                  <button
                    onClick={() => {
                      const selectedSketchIds = new Set(jobConfig.selectedSketchIds);
                      const holeIds: string[] = [];
                      for (const sketch of doc.sketches) {
                        if (!selectedSketchIds.has(sketch.id)) continue;
                        for (const e of sketch.entities) {
                          if (e.type !== 'circle') continue;
                          if ('construction' in e && e.construction) continue;
                          holeIds.push(e.id);
                        }
                      }
                      if (holeIds.length > 0) {
                        updateOperation(i, { entityIds: holeIds });
                      }
                    }}
                    style={{ ...btnStyle, fontSize: '9px', padding: '2px 6px' }}
                  >
                    All Circles
                  </button>
                )}
                {op.kind === 'pocket' && (
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
              </div>
              <div
                onClick={() => { setFocusedOperation(i); onShowCutting?.(); }}
                style={{
                  fontSize: '12px',
                  color: isFocused ? opColor : palette.text,
                  marginBottom: '4px',
                  marginTop: '2px',
                  padding: '3px 6px',
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: isFocused ? opColor + '15' : palette.inputBg,
                  borderRadius: '3px',
                  border: `1px solid ${isFocused ? opColor + '40' : 'transparent'}`,
                }}
                title="Click to edit tool & cutting settings"
              >
                <span>{op.cutting.tool.diameter}mm {op.cutting.tool.type}, F{op.cutting.feedRate}, D{op.cutting.depth.totalDepth}mm</span>
                {isFocused && <span style={{ fontSize: '9px', opacity: 0.7 }}>edit →</span>}
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
                  <label style={labelStyle}>Peck Depth (mm, 0=single plunge)</label>
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

              {op.kind === 'facing' && (
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
          {showGcodePreview && generatedGcode && (
            <button onClick={() => setShowGcodePreview(false)} style={btnStyle}>Hide G-code</button>
          )}
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

      {/* Simulator */}
      {toolpath && toolpath.length > 0 && (
        <div style={{ ...sectionStyle, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={headerStyle}>Simulator</div>
          <div style={{ display: 'flex', gap: '3px' }}>
            <button
              onClick={simState === 'playing' ? simPause : simPlay}
              style={{ ...btnStyle, flex: 1, fontSize: '13px' }}
              title={simState === 'playing' ? 'Pause' : 'Play'}
            >
              {simState === 'playing' ? '\u23F8' : '\u25B6'}
            </button>
            <button
              onClick={simStep}
              style={{ ...btnStyle, flex: 1, fontSize: '13px' }}
              title="Step"
            >
              {'\u23ED'}
            </button>
            <button
              onClick={simStop}
              style={{
                ...btnStyle,
                flex: 1,
                fontSize: '13px',
                opacity: simState === 'idle' ? 0.4 : 1,
              }}
              disabled={simState === 'idle'}
              title="Stop"
            >
              {'\u23F9'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: '2px' }}>
            {[0.5, 1, 2, 4].map((speed) => (
              <button
                key={speed}
                onClick={() => simSetSpeed(speed)}
                style={{
                  ...btnStyle,
                  flex: 1,
                  fontSize: '10px',
                  padding: '2px',
                  borderColor: simSpeed === speed ? palette.accent : palette.inputBorder,
                  color: simSpeed === speed ? palette.accent : palette.text,
                }}
              >
                {speed}x
              </button>
            ))}
          </div>
        </div>
      )}

      {/* G-code Preview */}
      {showGcodePreview && generatedGcode && (
        <GcodePreview gcode={generatedGcode} onClose={() => setShowGcodePreview(false)} />
      )}
    </div>
  );
}
