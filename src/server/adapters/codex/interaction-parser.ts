import type {
  DomainAgentInteraction,
  InteractionBindingAttempt,
} from "../../domain/session-domain.js";
import type { DecodedRecord, DecodedRollout } from "./rollout-decoder.js";
import { isObject } from "./rollout-decoder.js";

const CODEX_TMUX_ACTIVATION_COMMAND =
  "printf 'CODEX_VIEWER_TMUX_BIND_V1\\n%s\\n%s\\n' \"$TMUX\" \"$TMUX_PANE\"";
export const CODEX_TMUX_ACTIVATION = `! ${CODEX_TMUX_ACTIVATION_COMMAND}`;

const BIND_MARKER = "CODEX_VIEWER_TMUX_BIND_V1";

export function codexInteraction(decoded: DecodedRollout): DomainAgentInteraction {
  let bindingAttempt: InteractionBindingAttempt | null = null;

  for (const record of decoded.records) {
    const attempt = bindingAttemptFrom(record);
    if (
      attempt !== null &&
      (bindingAttempt === null || attempt.ordinal >= bindingAttempt.ordinal)
    ) bindingAttempt = attempt;
  }

  return { activation: CODEX_TMUX_ACTIVATION, bindingAttempt };
}

function bindingAttemptFrom(record: DecodedRecord): InteractionBindingAttempt | null {
  if (record.value.type !== "response_item") return null;
  const payload = record.value.payload;
  if (!isObject(payload) || payload.type !== "message" || payload.role !== "user") {
    return null;
  }
  const text = contentText(payload.content);
  if (text === null || !text.includes("<user_shell_command>")) return null;
  const shellBlocks = [...text.matchAll(/<user_shell_command>([\s\S]*?)<\/user_shell_command>/g)];
  let found: InteractionBindingAttempt | null = null;
  for (const block of shellBlocks) {
    const lines = (block[1] ?? "").replace(/\r\n?/g, "\n").split("\n");
    let blockAttempt: InteractionBindingAttempt | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] !== BIND_MARKER) continue;
      const tmux = lines[index + 1] ?? "";
      const paneId = lines[index + 2] ?? "";
      const match = /^(.*),(\d+),(\d+)$/.exec(tmux);
      blockAttempt = match !== null && match[1] !== "" && /^%\d+$/.test(paneId)
        ? {
            ordinal: record.ordinal,
            valid: true,
            socketPath: match[1],
            paneId,
          }
        : { ordinal: record.ordinal, valid: false };
    }
    if (blockAttempt !== null) found = blockAttempt;
    else if (lines.includes(CODEX_TMUX_ACTIVATION_COMMAND)) {
      found = { ordinal: record.ordinal, valid: false };
    }
  }
  const lastOpen = text.lastIndexOf("<user_shell_command>");
  const lastClose = text.lastIndexOf("</user_shell_command>");
  if (lastOpen > lastClose) {
    const incomplete = text.slice(lastOpen + "<user_shell_command>".length);
    const incompleteLines = incomplete.replace(/\r\n?/g, "\n").split("\n");
    if (
      incompleteLines.includes(BIND_MARKER) ||
      incompleteLines.includes(CODEX_TMUX_ACTIVATION_COMMAND)
    ) {
      found = { ordinal: record.ordinal, valid: false };
    }
  }
  return found;
}

function contentText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    if (!isObject(part) || typeof part.text !== "string") continue;
    if (part.type === "input_text" || part.type === "text") parts.push(part.text);
  }
  return parts.length === 0 ? null : parts.join("\n\n");
}
