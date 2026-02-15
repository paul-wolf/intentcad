import { useCamStore } from '@/stores/camStore';
import { useThemeStore } from '@/theme';

export function CamJobList() {
  const palette = useThemeStore((s) => s.palette);
  const jobs = useCamStore((s) => s.jobs);
  const activeJobId = useCamStore((s) => s.activeJobId);
  const openJob = useCamStore((s) => s.openJob);
  const deleteJob = useCamStore((s) => s.deleteJob);

  if (jobs.length === 0) {
    return (
      <div style={{ fontSize: '11px', color: palette.textMuted, padding: '4px 0' }}>
        No saved jobs
      </div>
    );
  }

  return (
    <div style={{ marginTop: '4px' }}>
      {jobs.map((job) => (
        <div
          key={job.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '3px 6px',
            borderRadius: '3px',
            background: job.id === activeJobId ? palette.activeItemBg : 'transparent',
            cursor: 'pointer',
            fontSize: '11px',
            color: palette.text,
            marginBottom: '2px',
          }}
        >
          <span
            onClick={() => openJob(job.id)}
            style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {job.name}
            {job.has_gcode && <span style={{ color: palette.constrained, marginLeft: '4px' }}>G</span>}
            {job.error_count > 0 && (
              <span style={{ color: palette.danger, marginLeft: '4px' }}>{job.error_count}!</span>
            )}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              deleteJob(job.id);
            }}
            style={{
              border: 'none',
              background: 'none',
              color: palette.danger,
              cursor: 'pointer',
              fontSize: '11px',
              padding: '0 4px',
            }}
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}
