import { useState, useEffect } from 'react';
import { useCamStore } from '@/stores/camStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { getBackendId } from '@/api/autoSave';
import { CamJobList } from './CamJobList';

export function GcodePanel() {
  const palette = useThemeStore((s) => s.palette);
  const doc = useDocumentStore((s) => s.document);
  const jobConfig = useCamStore((s) => s.jobConfig);
  const activeJobId = useCamStore((s) => s.activeJobId);
  const profiles = useCamStore((s) => s.profiles);
  const updateJobConfig = useCamStore((s) => s.updateJobConfig);
  const applyProfile = useCamStore((s) => s.applyProfile);
  const updateOperationCutting = useCamStore((s) => s.updateOperationCutting);
  const applyCuttingToAll = useCamStore((s) => s.applyCuttingToAll);
  const focusedOperationIndex = useCamStore((s) => s.focusedOperationIndex);

  const pickingOrigin = useCamStore((s) => s.pickingOrigin);
  const setPickingOrigin = useCamStore((s) => s.setPickingOrigin);

  const [showJobList, setShowJobList] = useState(false);

  // Load profiles on mount
  useEffect(() => {
    useCamStore.getState().loadProfiles();
    const backendId = getBackendId();
    if (backendId) {
      useCamStore.getState().loadJobs(backendId);
    }
  }, []);

  const focusedOp = focusedOperationIndex !== null ? jobConfig.operations[focusedOperationIndex] ?? null : null;
  const cutting = focusedOp?.cutting ?? null;

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

  const dimStyle: React.CSSProperties = {
    fontSize: '10px',
    color: palette.textMuted,
    fontStyle: 'italic',
    padding: '8px 10px',
    textAlign: 'center',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      {/* Job Section */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Job</div>
        <div style={{ fontSize: '11px', color: palette.textMuted, marginBottom: '4px' }}>
          {activeJobId ? `${activeJobId.slice(0, 8)}... (auto-saved)` : 'Creating...'}
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button onClick={() => {
            const docId = getBackendId();
            if (docId) useCamStore.getState().createJob(docId, `Job ${new Date().toLocaleString()}`);
          }} style={btnStyle}>New Job</button>
          <button onClick={() => setShowJobList(!showJobList)} style={btnStyle}>
            {showJobList ? 'Hide Jobs' : 'Show Jobs'}
          </button>
        </div>
        {showJobList && <CamJobList />}
      </div>

      {/* Profile Section */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Profile</div>
        <select
          value={jobConfig.profileId ?? ''}
          onChange={(e) => {
            if (e.target.value) applyProfile(e.target.value);
          }}
          style={inputStyle}
        >
          <option value="">Custom (no profile)</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {/* Sketch Selection */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Sketches</div>
        {doc.sketches.map((sketch) => (
          <label key={sketch.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: palette.text, marginBottom: '2px' }}>
            <input
              type="checkbox"
              checked={jobConfig.selectedSketchIds.includes(sketch.id)}
              onChange={(e) => {
                const ids = e.target.checked
                  ? [...jobConfig.selectedSketchIds, sketch.id]
                  : jobConfig.selectedSketchIds.filter((id) => id !== sketch.id);
                updateJobConfig({ selectedSketchIds: ids });
              }}
            />
            {sketch.name}
          </label>
        ))}
      </div>

      {/* Stock — job level */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Stock</div>
        <label style={labelStyle}>Thickness (mm)</label>
        <input
          type="number"
          value={jobConfig.stock.thickness}
          onChange={(e) => updateJobConfig({ stock: { ...jobConfig.stock, thickness: +e.target.value } })}
          style={inputStyle}
          min={0.1}
          step={0.5}
        />
        <label style={labelStyle}>Z Top (mm)</label>
        <input
          type="number"
          value={jobConfig.stock.zTop}
          onChange={(e) => updateJobConfig({ stock: { ...jobConfig.stock, zTop: +e.target.value } })}
          style={inputStyle}
          step={0.5}
        />
      </div>

      {/* Origin — job level */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Origin (WCS Zero)</div>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginBottom: '4px' }}>
          <button
            onClick={() => setPickingOrigin(!pickingOrigin)}
            style={{
              ...btnStyle,
              flex: 1,
              borderColor: pickingOrigin ? '#ff4444' : palette.inputBorder,
              color: pickingOrigin ? '#ff4444' : palette.text,
            }}
          >
            {pickingOrigin ? 'Click on canvas...' : 'Pick Origin'}
          </button>
          <button
            onClick={() => updateJobConfig({ origin: { x: 0, y: 0 } })}
            style={{ ...btnStyle, fontSize: '10px' }}
            title="Reset to sketch origin"
          >
            Reset
          </button>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>X</label>
            <input
              type="number"
              value={jobConfig.origin.x}
              onChange={(e) => updateJobConfig({ origin: { ...jobConfig.origin, x: +e.target.value } })}
              style={inputStyle}
              step={1}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Y</label>
            <input
              type="number"
              value={jobConfig.origin.y}
              onChange={(e) => updateJobConfig({ origin: { ...jobConfig.origin, y: +e.target.value } })}
              style={inputStyle}
              step={1}
            />
          </div>
        </div>
      </div>

      {/* Coolant — job level */}
      <div style={sectionStyle}>
        <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '4px' }}>
          <input
            type="checkbox"
            checked={jobConfig.useFloodCoolant}
            onChange={(e) => updateJobConfig({ useFloodCoolant: e.target.checked })}
          />
          Flood Coolant
        </label>
      </div>

      {/* ── Per-operation sections below ── */}

      {!cutting && (
        <div style={dimStyle}>
          Select an operation to edit tool, speeds, and depth settings
        </div>
      )}

      {cutting && focusedOperationIndex !== null && (
        <>
          {/* Operation header */}
          <div style={{ ...sectionStyle, background: palette.panelBg, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: palette.accent }}>
              Op {focusedOperationIndex + 1}: {focusedOp!.kind}
            </span>
            <button
              onClick={() => applyCuttingToAll(focusedOperationIndex)}
              style={{ ...btnStyle, fontSize: '9px', padding: '2px 6px' }}
              title="Copy these cutting settings to all operations"
            >
              Apply to All
            </button>
          </div>

          {/* Tool — per operation */}
          <div style={sectionStyle}>
            <div style={headerStyle}>Tool</div>
            <label style={labelStyle}>Diameter (mm)</label>
            <input
              type="number"
              value={cutting.tool.diameter}
              onChange={(e) => updateOperationCutting(focusedOperationIndex, { tool: { ...cutting.tool, diameter: +e.target.value } })}
              style={inputStyle}
              min={0.1}
              step={0.5}
            />
            <label style={labelStyle}>Type</label>
            <select
              value={cutting.tool.type}
              onChange={(e) => updateOperationCutting(focusedOperationIndex, { tool: { ...cutting.tool, type: e.target.value as 'flat' | 'ball' | 'vbit' | 'drill' } })}
              style={inputStyle}
            >
              <option value="flat">Flat End Mill</option>
              <option value="ball">Ball Nose</option>
              <option value="vbit">V-Bit</option>
              <option value="drill">Drill</option>
            </select>
            <label style={labelStyle}>Flute Count</label>
            <input
              type="number"
              value={cutting.tool.fluteCount}
              onChange={(e) => updateOperationCutting(focusedOperationIndex, { tool: { ...cutting.tool, fluteCount: +e.target.value } })}
              style={inputStyle}
              min={1}
              max={8}
            />
            <label style={labelStyle}>Flute Length (mm)</label>
            <input
              type="number"
              value={cutting.tool.fluteLength}
              onChange={(e) => updateOperationCutting(focusedOperationIndex, { tool: { ...cutting.tool, fluteLength: +e.target.value } })}
              style={inputStyle}
              min={1}
              step={1}
            />
          </div>

          {/* Cutting Params — per operation */}
          <div style={sectionStyle}>
            <div style={headerStyle}>Cutting</div>
            <label style={labelStyle}>Spindle Speed (RPM)</label>
            <input
              type="number"
              value={cutting.spindleSpeed}
              onChange={(e) => updateOperationCutting(focusedOperationIndex, { spindleSpeed: +e.target.value })}
              style={inputStyle}
              min={100}
              step={500}
            />
            <label style={labelStyle}>Feed Rate (mm/min)</label>
            <input
              type="number"
              value={cutting.feedRate}
              onChange={(e) => updateOperationCutting(focusedOperationIndex, { feedRate: +e.target.value })}
              style={inputStyle}
              min={10}
              step={50}
            />
            <label style={labelStyle}>Plunge Rate (mm/min)</label>
            <input
              type="number"
              value={cutting.plungeRate}
              onChange={(e) => updateOperationCutting(focusedOperationIndex, { plungeRate: +e.target.value })}
              style={inputStyle}
              min={10}
              step={10}
            />
            <label style={labelStyle}>Safe Z (mm)</label>
            <input
              type="number"
              value={cutting.safeZ}
              onChange={(e) => updateOperationCutting(focusedOperationIndex, { safeZ: +e.target.value })}
              style={inputStyle}
              min={1}
              step={1}
            />
          </div>

          {/* Depth — per operation */}
          <div style={sectionStyle}>
            <div style={headerStyle}>Depth</div>
            <label style={labelStyle}>Total Depth (mm)</label>
            <input
              type="number"
              value={cutting.depth.totalDepth}
              onChange={(e) => updateOperationCutting(focusedOperationIndex, { depth: { ...cutting.depth, totalDepth: +e.target.value } })}
              style={inputStyle}
              min={0.1}
              step={0.5}
            />
            <label style={labelStyle}>Depth per Pass (mm)</label>
            <input
              type="number"
              value={cutting.depth.depthPerPass}
              onChange={(e) => updateOperationCutting(focusedOperationIndex, { depth: { ...cutting.depth, depthPerPass: +e.target.value } })}
              style={inputStyle}
              min={0.1}
              step={0.25}
            />
            <label style={labelStyle}>Finish Allowance (mm)</label>
            <input
              type="number"
              value={cutting.depth.finalPassAllowance}
              onChange={(e) => updateOperationCutting(focusedOperationIndex, { depth: { ...cutting.depth, finalPassAllowance: +e.target.value } })}
              style={inputStyle}
              min={0}
              step={0.05}
            />
          </div>
        </>
      )}
    </div>
  );
}
