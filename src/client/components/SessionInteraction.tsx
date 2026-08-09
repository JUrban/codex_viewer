import type { InteractionResponse } from "../../shared/api-contract";
import { useSessionInteraction } from "../state/use-session-interaction";
import { InteractionPanel } from "./InteractionPanel";

interface SessionInteractionProps {
  interaction: InteractionResponse | null;
  sessionId: string;
  itemCount: number;
  updatedAt: string | null;
}

export function SessionInteraction({
  interaction,
  sessionId,
  itemCount,
  updatedAt,
}: SessionInteractionProps) {
  const previewAvailable = interaction?.supported === true &&
    interaction.state === "connected";
  const controller = useSessionInteraction(sessionId, previewAvailable);

  return (
    <InteractionPanel
      interaction={interaction}
      itemCount={itemCount}
      updatedAt={updatedAt}
      interactionBusy={controller.interactionBusy}
      error={controller.error}
      onDismissError={controller.clearError}
      onSendMessage={controller.sendMessage}
      onSendKeys={controller.sendKeys}
      preview={controller.preview}
      previewBusy={controller.previewBusy}
      previewError={controller.previewError}
      onDismissPreviewError={controller.clearPreviewError}
      onPreviewTerminal={controller.previewTerminal}
      onCancelPreviewTerminal={controller.cancelPreviewTerminal}
    />
  );
}
