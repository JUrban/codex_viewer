import { useCallback, useState } from "react";
import {
  DEFAULT_TIMELINE_VISIBILITY,
  type TimelineVisibility,
  type TimelineVisibilityKey,
} from "./timeline-visibility";

export function useTimelineVisibility() {
  const [visibility, setVisibilityState] = useState<TimelineVisibility>(() => ({
    ...DEFAULT_TIMELINE_VISIBILITY,
  }));

  const setVisibility = useCallback((key: TimelineVisibilityKey, visible: boolean) => {
    setVisibilityState((current) => (
      current[key] === visible ? current : { ...current, [key]: visible }
    ));
  }, []);

  return { visibility, setVisibility };
}
