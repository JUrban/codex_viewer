export const DECODER_VERSION = 1;
export const MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024;
export const MAX_MESSAGE_CHARS = 1_000_000;
export const MAX_TOOL_DETAIL_CHARS = 256_000;
export const MAX_PREVIEW_CHARS = 240;
export const MAX_INJECTED_CONTEXT_CHARS = 256_000;

export function truncateText(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}
