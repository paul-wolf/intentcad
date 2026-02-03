import { create } from 'zustand';

export interface ThemePalette {
  // Canvas
  background: string;
  gridMinor: string;
  gridMajor: string;
  line: string;
  lineSelected: string;
  ghosted: string;
  preview: string;
  snap: string;
  selectionRect: string;
  selectionRectBorder: string;
  dimension: string;
  dimensionText: string;
  dimensionOverlay: string;
  axisX: string;
  axisY: string;
  origin: string;

  // UI chrome
  panelBg: string;
  border: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  activeItemBg: string;
  accent: string;
  danger: string;
  buttonBg: string;
  inputBg: string;
  inputBorder: string;
  primaryBtn: string;
  warning: string;
}

export const DARK_PALETTE: ThemePalette = {
  background: '#0f172a',
  gridMinor: '#1e293b',
  gridMajor: '#334155',
  line: '#e2e8f0',
  lineSelected: '#60a5fa',
  ghosted: '#9ca3af',
  preview: '#94a3b8',
  snap: '#fbbf24',
  selectionRect: 'rgba(96, 165, 250, 0.15)',
  selectionRectBorder: '#60a5fa',
  dimension: '#86efac',
  dimensionText: '#86efac',
  dimensionOverlay: '#fde68a',
  axisX: '#ef4444',
  axisY: '#22c55e',
  origin: '#94a3b8',

  panelBg: '#1e293b',
  border: '#334155',
  text: '#e2e8f0',
  textSecondary: '#64748b',
  textMuted: '#94a3b8',
  activeItemBg: '#0f172a',
  accent: '#60a5fa',
  danger: '#ef4444',
  buttonBg: '#0f172a',
  inputBg: '#0f172a',
  inputBorder: '#475569',
  primaryBtn: '#3b82f6',
  warning: '#f59e0b',
};

export const LIGHT_PALETTE: ThemePalette = {
  background: '#f8fafc',
  gridMinor: '#e2e8f0',
  gridMajor: '#cbd5e1',
  line: '#1e293b',
  lineSelected: '#2563eb',
  ghosted: '#94a3b8',
  preview: '#64748b',
  snap: '#d97706',
  selectionRect: 'rgba(37, 99, 235, 0.12)',
  selectionRectBorder: '#2563eb',
  dimension: '#16a34a',
  dimensionText: '#16a34a',
  dimensionOverlay: '#d97706',
  axisX: '#dc2626',
  axisY: '#16a34a',
  origin: '#64748b',

  panelBg: '#f1f5f9',
  border: '#cbd5e1',
  text: '#1e293b',
  textSecondary: '#64748b',
  textMuted: '#94a3b8',
  activeItemBg: '#e2e8f0',
  accent: '#2563eb',
  danger: '#dc2626',
  buttonBg: '#e2e8f0',
  inputBg: '#ffffff',
  inputBorder: '#94a3b8',
  primaryBtn: '#2563eb',
  warning: '#d97706',
};

const STORAGE_KEY = 'intentcad-theme';

type ThemeChoice = 'dark' | 'light';

function loadTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* ignore */ }
  return 'dark';
}

interface ThemeStore {
  theme: ThemeChoice;
  palette: ThemePalette;
  toggleTheme(): void;
  setTheme(t: ThemeChoice): void;
}

function paletteFor(t: ThemeChoice): ThemePalette {
  return t === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
}

const initialTheme = loadTheme();

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: initialTheme,
  palette: paletteFor(initialTheme),
  toggleTheme() {
    set((s) => {
      const next: ThemeChoice = s.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
      return { theme: next, palette: paletteFor(next) };
    });
  },
  setTheme(t: ThemeChoice) {
    try { localStorage.setItem(STORAGE_KEY, t); } catch { /* ignore */ }
    set({ theme: t, palette: paletteFor(t) });
  },
}));

/** Imperative access for tools / rendering code outside React */
export function getThemePalette(): ThemePalette {
  return useThemeStore.getState().palette;
}
