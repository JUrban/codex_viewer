import { commandLineHelp, loadConfig } from "./config.js";
import { createCodexSessionReadService } from "./create-session-read-service.js";
import { createApiRouter } from "./http/api-router.js";
import { createServer, listenServer } from "./http/create-server.js";
import { SessionInteractionService } from "./interaction/interaction-service.js";
import { SessionLiveService } from "./live/session-live-service.js";

async function main(): Promise<void> {
  const command = loadConfig();
  if (command.kind === "help") {
    console.log(commandLineHelp());
    return;
  }

  const { config } = command;
  const sessions = await createCodexSessionReadService(
    config.codexHome,
    config.sessionAllowlistPath,
  );
  const interaction = new SessionInteractionService(
    sessions,
    config.interactionEnabled,
  );
  const live = new SessionLiveService(sessions, { interaction });
  const server = createServer(
    config,
    createApiRouter({ sessions, live, interaction }),
  );

  await listenServer(server, config.port, config.host);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  const protocol = config.tls.enabled ? "https" : "http";
  const mutualTls = config.tls.enabled && config.tls.certificateAuthorityPath
    ? " (client certificates required)"
    : "";
  console.log(`Codex Sessions Reader listening on ${protocol}://${host}:${port}${mutualTls}`);

  function close(): void {
    server.close((error) => {
      if (error) {
        console.error("Failed to stop Codex Sessions Reader");
        process.exitCode = 1;
      }
    });
  }

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Failed to start Codex Sessions Reader");
  process.exitCode = 1;
});
