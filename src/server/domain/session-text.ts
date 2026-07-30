export const MAX_PREVIEW_CHARS = 240;
export const MAX_SESSION_TITLE_CHARS = 80;

export function truncateText(
  value: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}

export function normalizeSessionTitle(value: string | null): string | null {
  if (value === null) return null;
  const firstLine = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine === undefined
    ? null
    : truncateText(firstLine, MAX_SESSION_TITLE_CHARS).text;
}
