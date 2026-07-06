/**
 * Design tokens for the redesigned chrome (login / projects / project pages).
 * Kept separate from the editor's ThemePalette so restyling these pages can't
 * affect the 2D/3D editors. Values from the IntentCAD redesign spec.
 */
import { useThemeStore } from '@/theme';

export interface Tokens {
  appBg: string; surface: string; surface2: string; surface3: string;
  border: string; border2: string;
  text: string; textDim: string; textMute: string;
  accent: string; accentSoft: string;
  part: string; partSoft: string; sketch: string; sketchSoft: string;
  danger: string; grid: string; thumbBg: string; thumbLine: string; shadow: string;
}

export const SANS = "'IBM Plex Sans', system-ui, sans-serif";
export const MONO = "'IBM Plex Mono', ui-monospace, monospace";

const DARK: Tokens = {
  appBg: '#0e1420', surface: '#161d2b', surface2: '#1b2436', surface3: '#212c40',
  border: '#243044', border2: '#33415a', text: '#e7edf6', textDim: '#98a6bd', textMute: '#5e6c83',
  accent: '#4c8dff', accentSoft: 'rgba(76,141,255,0.14)',
  part: '#e6a54c', partSoft: 'rgba(230,165,76,0.15)', sketch: '#4c8dff', sketchSoft: 'rgba(76,141,255,0.14)',
  danger: '#f2555a', grid: 'rgba(255,255,255,0.05)', thumbBg: '#0f1828', thumbLine: '#8aa0c4',
  shadow: '0 14px 34px -14px rgba(0,0,0,0.65)',
};

const LIGHT: Tokens = {
  appBg: '#eef1f6', surface: '#ffffff', surface2: '#f5f8fc', surface3: '#e9eff6',
  border: '#dde4ee', border2: '#c6d1e0', text: '#16212e', textDim: '#566274', textMute: '#8592a5',
  accent: '#2f6fe0', accentSoft: 'rgba(47,111,224,0.10)',
  part: '#c67d1e', partSoft: 'rgba(198,125,30,0.12)', sketch: '#2f6fe0', sketchSoft: 'rgba(47,111,224,0.10)',
  danger: '#d63a3f', grid: 'rgba(20,45,90,0.06)', thumbBg: '#f6f9fc', thumbLine: '#4a627f',
  shadow: '0 16px 30px -16px rgba(30,50,90,0.28)',
};

export function useTokens(): Tokens & { isDark: boolean } {
  const theme = useThemeStore((s) => s.theme);
  return { ...(theme === 'dark' ? DARK : LIGHT), isDark: theme === 'dark' };
}
