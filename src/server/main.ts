import { loadConfig } from "./config.js";
import { createApiRouter } from "./http/api-router.js";
import { createServer } from "./http/create-server.js";
import { createCodexSessionRepository } from "./create-session-repository.js";

const config = loadConfig();
const repository = await createCodexSessionRepository(config.codexHome);
const server = createServer(config, createApiRouter(repository));

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  console.log(`Codex Sessions Reader listening on http://${host}:${port}`);
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
