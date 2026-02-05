import { create } from 'zustand';

export interface LogEntry {
  id: number;
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const MAX_ENTRIES = 200;

let nextId = 1;

interface LogStore {
  entries: LogEntry[];
  addLog(level: LogEntry['level'], message: string): void;
  clear(): void;
}

export const useLogStore = create<LogStore>((set) => ({
  entries: [],

  addLog(level, message) {
    const entry: LogEntry = {
      id: nextId++,
      timestamp: Date.now(),
      level,
      message,
    };
    set((s) => ({
      entries: [...s.entries, entry].slice(-MAX_ENTRIES),
    }));
  },

  clear() {
    set({ entries: [] });
  },
}));

/** Imperative helper for use outside React components. */
export function addLog(level: LogEntry['level'], message: string) {
  useLogStore.getState().addLog(level, message);
}
