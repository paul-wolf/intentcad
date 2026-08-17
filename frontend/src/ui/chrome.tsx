import { useThemeStore } from '@/theme';
import { useTokens } from './tokens';

/** The IntentCAD diamond mark. */
export function Logo({ size = 24 }: { size?: number }) {
  const t = useTokens();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill={t.accentSoft} stroke={t.accent} strokeWidth={1.4} />
      <path d="M12 6l6 6-6 6-6-6z" fill="none" stroke={t.accent} strokeWidth={1.5} />
    </svg>
  );
}

/** The IntentCAD wordmark (Intent + accent CAD). */
export function Wordmark({ size = 16 }: { size?: number }) {
  const t = useTokens();
  return (
    <span style={{ fontWeight: 700, fontSize: size, letterSpacing: '-0.4px', color: t.text }}>
      Intent<span style={{ color: t.accent }}>CAD</span>
    </span>
  );
}

/** Sun/moon theme toggle. */
export function ThemeToggle({ size = 34 }: { size?: number }) {
  const t = useTokens();
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  return (
    <button
      onClick={toggleTheme}
      title="Toggle theme"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: size, height: size,
               background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 8, color: t.textDim, cursor: 'pointer' }}
    >
      {t.isDark ? (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.5A8.5 8.5 0 1 1 11.5 3 6.5 6.5 0 0 0 21 12.5z" />
        </svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" />
        </svg>
      )}
    </button>
  );
}
