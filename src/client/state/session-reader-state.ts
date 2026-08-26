import type { LiveRevision, TimelineCursor } from "../../shared/api-contract";
import type { SessionDetail } from "../../shared/domain";

export interface ReaderContext {
  cursor: TimelineCursor;
  previousCursor: TimelineCursor | null;
  session: SessionDetail;
  hasMore: boolean;
  liveRevision: LiveRevision;
}
