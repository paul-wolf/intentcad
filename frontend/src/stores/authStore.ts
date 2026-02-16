import { create } from 'zustand';
import { authApi } from '@/api/authClient';
import { clearCsrfToken } from '@/api/client';
import type { User } from '@/types/auth';

interface AuthStore {
  user: User | null;
  loading: boolean;
  error: string | null;
  checkAuth(): Promise<void>;
  login(username: string, password: string): Promise<boolean>;
  logout(): Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  loading: true,
  error: null,

  async checkAuth() {
    try {
      const user = await authApi.me();
      set({ user, loading: false, error: null });
    } catch {
      set({ user: null, loading: false, error: null });
    }
  },

  async login(username: string, password: string): Promise<boolean> {
    set({ error: null });
    try {
      const result = await authApi.login(username, password);
      set({ user: result.user, error: null });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      set({ error: message });
      return false;
    }
  },

  async logout() {
    try {
      await authApi.logout();
    } catch {
      // ignore errors during logout
    }
    clearCsrfToken();
    set({ user: null, error: null });
  },
}));
