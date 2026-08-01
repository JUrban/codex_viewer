import { commandLineHelp, loadConfig } from "./config.js";
import { createApiRouter } from "./http/api-router.js";
import { createServer } from "./http/create-server.js";
import { createCodexSessionRepository } from "./create-session-repository.js";

async function main(): Promise<void> {
  const command = loadConfig();
  if (command.kind === "help") {
    console.log(commandLineHelp());
    return;
  }

  const { config } = command;
  const repository = await createCodexSessionRepository(config.codexHome);
  const server = createServer(config, createApiRouter(repository));

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    const host = config.host.includes(":") ? `[${config.host}]` : config.host;
    const protocol = config.tls.enabled ? "https" : "http";
    const mutualTls = config.tls.enabled && config.tls.certificateAuthorityPath
      ? " (client certificates required)"
      : "";
    console.log(`Codex Sessions Reader listening on ${protocol}://${host}:${port}${mutualTls}`);
  });

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
