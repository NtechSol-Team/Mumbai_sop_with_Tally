import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthUser } from '@/types/api';

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  hydrated: boolean;
  setSession: (p: { user: AuthUser; accessToken: string; refreshToken: string }) => void;
  setTokens: (t: { accessToken: string; refreshToken: string }) => void;
  setUser: (u: AuthUser) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      hydrated: false,
      setSession: ({ user, accessToken, refreshToken }) => set({ user, accessToken, refreshToken }),
      setTokens: ({ accessToken, refreshToken }) => set({ accessToken, refreshToken }),
      setUser: (user) => set({ user }),
      clear: () => set({ user: null, accessToken: null, refreshToken: null }),
    }),
    {
      name: 'mumbai-erp-auth',
      onRehydrateStorage: () => (state) => {
        if (state) state.hydrated = true;
      },
    },
  ),
);

// Non-reactive snapshot accessors for use inside the axios interceptor.
export const authSnapshot = {
  get: () => useAuthStore.getState(),
};

// Keep every same-origin tab's in-memory tokens in sync with whichever tab last
// wrote to localStorage. Without this, a tab left open in the background never
// learns that another tab already rotated the (shared, single) refresh token —
// so when it wakes up and its own access token has expired, it presents a token
// the server rotated away from many cycles ago, which reads as reuse and revokes
// the whole session, logging out every tab. Syncing here means a tab is never
// more than one rotation behind, which is what the server's short grace window
// (see auth.service.ts) is sized to tolerate, rather than minutes of drift.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'mumbai-erp-auth') useAuthStore.persist.rehydrate();
  });
}
