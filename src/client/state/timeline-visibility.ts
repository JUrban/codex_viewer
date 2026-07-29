import type { TimelineItem } from "../../shared/domain";

export interface TimelineVisibility {
  directive: boolean;
  tools: boolean;
  token: boolean;
  internal: boolean;
}

export type TimelineVisibilityKey = keyof TimelineVisibility;

export const DEFAULT_TIMELINE_VISIBILITY: TimelineVisibility = {
  directive: false,
  tools: false,
  token: false,
  internal: false,
};

export function isTimelineItemVisible(
  item: TimelineItem,
  visibility: TimelineVisibility,
): boolean {
  switch (item.kind) {
    case "message":
      return true;
    case "directive":
      return visibility.directive;
    case "tool":
      return visibility.tools;
    case "token":
      return visibility.token;
    case "internal":
      return visibility.internal;
  }
}
