import { useState, useEffect } from 'react';
import { useCamStore } from '@/stores/camStore';
import { useDocumentStore } from '@/stores/documentStore';
import { useThemeStore } from '@/theme';
import { getBackendId } from '@/api/autoSave';
import { addLog } from '@/stores/logStore';
import { CamJobList } from './CamJobList';

export function GcodePanel() {
  const palette = useThemeStore((s) => s.palette);
  const doc = useDocumentStore((s) => s.document);
  const jobConfig = useCamStore((s) => s.jobConfig);
  const activeJobId = useCamStore((s) => s.activeJobId);
  const profiles = useCamStore((s) => s.profiles);
  const updateJobConfig = useCamStore((s) => s.updateJobConfig);
  const saveJob = useCamStore((s) => s.saveJob);
  const applyProfile = useCamStore((s) => s.applyProfile);
  const createJob = useCamStore((s) => s.createJob);

  const jobs = useCamStore((s) => s.jobs);
  const pickingOrigin = useCamStore((s) => s.pickingOrigin);
  const setPickingOrigin = useCamStore((s) => s.setPickingOrigin);

  const [newJobName, setNewJobName] = useState('');
  const [showJobList, setShowJobList] = useState(false);

  // Default job name: "<document name> Job N"
  useEffect(() => {
    if (newJobName === '' || newJobName.startsWith(doc.name)) {
      const nextNum = jobs.length + 1;
      setNewJobName(`${doc.name || 'Untitled'} Job ${nextNum}`);
    }
  }, [doc.name, jobs.length]);

  // Load profiles on mount
  useEffect(() => {
    useCamStore.getState().loadProfiles();
    const backendId = getBackendId();
    if (backendId) {
      useCamStore.getState().loadJobs(backendId);
    }
  }, []);

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

  const handleNewJob = () => {
    const backendId = getBackendId();
    if (!backendId) {
      addLog('warn', 'Save the document first before creating a CAM job');
      return;
    }
    if (!newJobName.trim()) {
      addLog('warn', 'Enter a job name');
      return;
    }
    createJob(backendId, newJobName.trim());
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      {/* Job Section */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Job</div>
        {activeJobId ? (
          <div style={{ fontSize: '12px', color: palette.text, marginBottom: '4px' }}>
            Active job: {activeJobId.slice(0, 8)}...
            <button onClick={saveJob} style={{ ...btnStyle, marginLeft: '4px' }}>Save</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '4px' }}>
            <input
              value={newJobName}
              onChange={(e) => setNewJobName(e.target.value)}
              placeholder="Job name"
              style={{ ...inputStyle, flex: 1 }}
              onKeyDown={(e) => e.key === 'Enter' && handleNewJob()}
            />
            <button onClick={handleNewJob} style={btnStyle}>New</button>
          </div>
        )}
        <div style={{ marginTop: '4px' }}>
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

      {/* Tool */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Tool</div>
        <label style={labelStyle}>Diameter (mm)</label>
        <input
          type="number"
          value={jobConfig.tool.diameter}
          onChange={(e) => updateJobConfig({ tool: { ...jobConfig.tool, diameter: +e.target.value } })}
          style={inputStyle}
          min={0.1}
          step={0.5}
        />
        <label style={labelStyle}>Type</label>
        <select
          value={jobConfig.tool.type}
          onChange={(e) => updateJobConfig({ tool: { ...jobConfig.tool, type: e.target.value as 'flat' | 'ball' | 'vbit' | 'drill' } })}
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
          value={jobConfig.tool.fluteCount}
          onChange={(e) => updateJobConfig({ tool: { ...jobConfig.tool, fluteCount: +e.target.value } })}
          style={inputStyle}
          min={1}
          max={8}
        />
        <label style={labelStyle}>Flute Length (mm)</label>
        <input
          type="number"
          value={jobConfig.tool.fluteLength}
          onChange={(e) => updateJobConfig({ tool: { ...jobConfig.tool, fluteLength: +e.target.value } })}
          style={inputStyle}
          min={1}
          step={1}
        />
      </div>

      {/* Stock */}
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

      {/* Origin */}
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

      {/* Machine */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Machine</div>
        <label style={labelStyle}>Spindle Speed (RPM)</label>
        <input
          type="number"
          value={jobConfig.machine.spindleSpeed}
          onChange={(e) => updateJobConfig({ machine: { ...jobConfig.machine, spindleSpeed: +e.target.value } })}
          style={inputStyle}
          min={100}
          step={500}
        />
        <label style={labelStyle}>Feed Rate (mm/min)</label>
        <input
          type="number"
          value={jobConfig.machine.feedRate}
          onChange={(e) => updateJobConfig({ machine: { ...jobConfig.machine, feedRate: +e.target.value } })}
          style={inputStyle}
          min={10}
          step={50}
        />
        <label style={labelStyle}>Plunge Rate (mm/min)</label>
        <input
          type="number"
          value={jobConfig.machine.plungeRate}
          onChange={(e) => updateJobConfig({ machine: { ...jobConfig.machine, plungeRate: +e.target.value } })}
          style={inputStyle}
          min={10}
          step={10}
        />
        <label style={labelStyle}>Safe Z (mm)</label>
        <input
          type="number"
          value={jobConfig.machine.safeZ}
          onChange={(e) => updateJobConfig({ machine: { ...jobConfig.machine, safeZ: +e.target.value } })}
          style={inputStyle}
          min={1}
          step={1}
        />
        <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
          <input
            type="checkbox"
            checked={jobConfig.machine.useFloodCoolant}
            onChange={(e) => updateJobConfig({ machine: { ...jobConfig.machine, useFloodCoolant: e.target.checked } })}
          />
          Flood Coolant
        </label>
      </div>

      {/* Depth */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Depth</div>
        <label style={labelStyle}>Total Depth (mm)</label>
        <input
          type="number"
          value={jobConfig.depth.totalDepth}
          onChange={(e) => updateJobConfig({ depth: { ...jobConfig.depth, totalDepth: +e.target.value } })}
          style={inputStyle}
          min={0.1}
          step={0.5}
        />
        <label style={labelStyle}>Depth per Pass (mm)</label>
        <input
          type="number"
          value={jobConfig.depth.depthPerPass}
          onChange={(e) => updateJobConfig({ depth: { ...jobConfig.depth, depthPerPass: +e.target.value } })}
          style={inputStyle}
          min={0.1}
          step={0.25}
        />
        <label style={labelStyle}>Finish Allowance (mm)</label>
        <input
          type="number"
          value={jobConfig.depth.finalPassAllowance}
          onChange={(e) => updateJobConfig({ depth: { ...jobConfig.depth, finalPassAllowance: +e.target.value } })}
          style={inputStyle}
          min={0}
          step={0.05}
        />
      </div>
    </div>
  );
}
