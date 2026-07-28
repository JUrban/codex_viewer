import { loadConfig } from "./config.js";
import { createApiRouter } from "./http/api-router.js";
import { createServer } from "./http/create-server.js";
import { createSessionRepository } from "./repository/create-session-repository.js";

const config = loadConfig();
const repository = await createSessionRepository(
  config.codexHome,
  process.env.CODEX_VIEWER_DISABLE_SQLITE === "1",
);
const server = createServer(config, createApiRouter(repository));

server.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(`Codex Sessions Reader listening on http://${config.host}:${port}`);
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
