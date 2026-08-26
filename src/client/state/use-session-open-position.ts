import { useCallback, useState } from "react";
import type { ItemPagePosition } from "../../shared/api-contract";

export const SESSION_OPEN_POSITION_STORAGE_KEY =
  "codex-sessions-reader.open-position.v1";

export function useSessionOpenPosition() {
  const [position, setPositionState] = useState<ItemPagePosition>(readPreference);

  const setPosition = useCallback((next: ItemPagePosition) => {
    setPositionState(next);
    try {
      localStorage.setItem(SESSION_OPEN_POSITION_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable in privacy modes; the preference still works in memory.
    }
  }, []);

  return [position, setPosition] as const;
}

function readPreference(): ItemPagePosition {
  try {
    return localStorage.getItem(SESSION_OPEN_POSITION_STORAGE_KEY) === "latest"
      ? "latest"
      : "beginning";
  } catch {
    return "beginning";
  }
}
