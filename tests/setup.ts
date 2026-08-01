import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { cleanupTempDirectories } from "./helpers/temp-directories.js";

if (typeof window !== "undefined" && window.localStorage === undefined) {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

afterEach(cleanupTempDirectories);
afterEach(() => {
  vi.useRealTimers();
  if (typeof window === "undefined") return;
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  window.history.replaceState(null, "", "/");
});
