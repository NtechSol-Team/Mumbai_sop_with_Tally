import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Holds the developer passphrase that unlocks the hidden outlet-management window.
 * Kept in sessionStorage (not localStorage) so it clears when the tab closes —
 * it's re-sent as the `x-developer-key` header on every outlet write and verified
 * server-side, so it never persists longer than the working session.
 */
interface DevState {
  devKey: string | null;
  setDevKey: (key: string) => void;
  clearDevKey: () => void;
}

export const useDevStore = create<DevState>()(
  persist(
    (set) => ({
      devKey: null,
      setDevKey: (key) => set({ devKey: key }),
      clearDevKey: () => set({ devKey: null }),
    }),
    {
      name: 'mumbai-erp-dev',
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);

/** Read the current key outside React (for one-off axios calls). */
export const getDevKey = () => useDevStore.getState().devKey;
