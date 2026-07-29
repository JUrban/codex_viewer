import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanupTempDirectories } from "./helpers/temp-directories.js";

afterEach(cleanupTempDirectories);
afterEach(() => {
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
});
