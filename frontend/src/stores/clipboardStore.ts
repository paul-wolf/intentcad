import { create } from 'zustand';

export type ClipboardEntry =
  | { type: 'document'; name: string; sketchCount: number; entityCount: number; json: string; timestamp: number }
  | { type: 'entities'; count: number; kinds: string[]; json: string; timestamp: number };

interface ClipboardStore {
  entry: ClipboardEntry | null;
  set(entry: ClipboardEntry): void;
  clear(): void;
}

export const useClipboardStore = create<ClipboardStore>((set) => ({
  entry: null,
  set: (entry) => set({ entry }),
  clear: () => set({ entry: null }),
}));
