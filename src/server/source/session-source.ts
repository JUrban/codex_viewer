import type {
  DomainDiagnostic,
  DomainSessionOrigin,
  NormalizedSession,
} from "../domain/session-domain.js";

export interface SessionSourceDescriptor {
  readonly sourceType: string;
  readonly instanceKey: string;
  readonly sourceInstanceId: string;
  readonly displayName: string;
}

export interface SourceSessionEntry {
  readonly localId: string;
  readonly nativeSessionId: string | null;
  readonly parentNativeSessionId: string | null;
  readonly origin: DomainSessionOrigin;
  readonly normalized: NormalizedSession;
}

export interface SessionSourceSnapshot {
  readonly signature: string;
  readonly sessions: readonly SourceSessionEntry[];
  readonly diagnostics: readonly DomainDiagnostic[];
}

export interface SessionSource {
  readonly descriptor: SessionSourceDescriptor;
  refresh(): Promise<SessionSourceSnapshot>;
}
