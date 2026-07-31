import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
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
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
  if (typeof window !== "undefined") window.localStorage.clear();
});
