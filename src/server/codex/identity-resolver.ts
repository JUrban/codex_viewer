import { basename } from "node:path";
import type { AgentIdentity } from "../../shared/domain.js";
import { nonEmptyAgentIdentity, taskNameFromAgentPath } from "./agent-identity.js";
import type { DecodedRollout } from "./rollout-decoder.js";
import { isObject } from "./rollout-decoder.js";

export interface SessionMetadata {
  threadId: string | null;
  title: string | null;
  cwd: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  parentThreadId: string | null;
  archived: boolean;
  agent?: AgentIdentity | null;
}

interface RawMetadata {
  id: string | null;
  title: string | null;
  cwd: string | null;
  timestamp: string | null;
  parentThreadId: string | null;
  agent: AgentIdentity | null;
}

export class IdentityResolver {
  resolve(decoded: DecodedRollout): SessionMetadata {
    const candidates = decoded.records
      .filter((record) => record.value.type === "session_meta")
      .map((record) => rawMetadata(record.value.payload))
      .filter((metadata): metadata is RawMetadata => metadata !== null);
    const fileName = basename(decoded.descriptor.canonicalPath);
    const matching = candidates.find((candidate) => candidate.id !== null && fileName.includes(candidate.id));
    const raw = matching ?? candidates[0] ?? null;

    return {
      threadId: raw?.id ?? null,
      title: raw?.title ?? null,
      cwd: raw?.cwd ?? null,
      createdAt: raw?.timestamp ?? timestampOf(decoded.records[0]?.value),
      updatedAt: lastTimestamp(decoded),
      parentThreadId: raw?.parentThreadId ?? null,
      archived: decoded.descriptor.archived,
      agent: raw?.agent ?? null,
    };
  }
}

function rawMetadata(value: unknown): RawMetadata | null {
  if (!isObject(value)) return null;
  return {
    id: string(value.id),
    title: string(value.title),
    cwd: string(value.cwd),
    timestamp: string(value.timestamp),
    parentThreadId: string(value.parent_thread_id ?? value.parent_id),
    agent: rawAgent(value),
  };
}

function rawAgent(value: Record<string, unknown>): AgentIdentity | null {
  const source = isObject(value.source) ? value.source : null;
  const subagent = source?.subagent;
  const spawn = isObject(subagent) && isObject(subagent.thread_spawn)
    ? subagent.thread_spawn
    : null;
  return nonEmptyAgentIdentity({
    taskName: taskNameFromAgentPath(string(value.agent_path) ?? string(spawn?.agent_path)),
    nickname: string(value.agent_nickname) ?? string(spawn?.agent_nickname),
    role: string(value.agent_role) ?? string(spawn?.agent_role) ??
      (typeof subagent === "string" ? subagent : null),
  });
}

function lastTimestamp(decoded: DecodedRollout): string | null {
  for (let index = decoded.records.length - 1; index >= 0; index -= 1) {
    const timestamp = timestampOf(decoded.records[index]?.value);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function timestampOf(record: Record<string, unknown> | undefined): string | null {
  return record === undefined ? null : string(record.timestamp);
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
