import type { TimelineItem } from "../../shared/domain";

export interface TimelineVisibility {
  tools: boolean;
  context: boolean;
  reasoning: boolean;
  internal: boolean;
}

export type TimelineVisibilityKey = keyof TimelineVisibility;

export const DEFAULT_TIMELINE_VISIBILITY: TimelineVisibility = {
  tools: false,
  context: false,
  reasoning: false,
  internal: false,
};

export function isTimelineItemVisible(
  item: TimelineItem,
  visibility: TimelineVisibility,
): boolean {
  switch (item.kind) {
    case "message":
      return true;
    case "tool":
      return visibility.tools;
    case "injected-context":
      return visibility.context;
    case "reasoning":
      return visibility.reasoning;
    case "internal":
      return visibility.internal;
  }
}
