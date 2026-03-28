import { useEffect } from 'react';
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

  const pickingOrigin = useCamStore((s) => s.pickingOrigin);
  const setPickingOrigin = useCamStore((s) => s.setPickingOrigin);


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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      {/* Job Section */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Job</div>
        <div style={{ fontSize: '11px', color: palette.textMuted, marginBottom: '4px' }}>
          {activeJobId ? `${activeJobId.slice(0, 8)}... (auto-saved)` : 'Creating...'}
        </div>
        <button onClick={() => {
          const docId = getBackendId();
          if (docId) useCamStore.getState().createJob(docId, `Job ${new Date().toLocaleString()}`);
        }} style={btnStyle}>New Job</button>
        <CamJobList />
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

    </div>
  );
}
