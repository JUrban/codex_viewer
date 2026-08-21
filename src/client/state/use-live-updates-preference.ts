import { useCallback, useState } from "react";

export const LIVE_UPDATES_STORAGE_KEY = "codex-sessions-reader.live-updates.v1";

export function useLiveUpdatesPreference() {
  const [enabled, setEnabledState] = useState(readPreference);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      sessionStorage.setItem(LIVE_UPDATES_STORAGE_KEY, String(next));
    } catch {
      // Storage can be unavailable in privacy modes; the preference still works in memory.
    }
  }, []);

  return [enabled, setEnabled] as const;
}

function readPreference(): boolean {
  try {
    return sessionStorage.getItem(LIVE_UPDATES_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}
