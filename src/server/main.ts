import { loadConfig } from "./config.js";
import { createServer } from "./http/create-server.js";

const config = loadConfig();
const server = createServer(config);

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

