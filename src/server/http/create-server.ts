import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer, type RequestListener, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { extname, resolve, sep } from "node:path";
import type { ServerConfig } from "../config.js";
import { emptyApiRouter, sendJson, type ApiRouter } from "./router.js";
import { applySecurityHeaders } from "./security.js";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendText(response: ServerResponse, status: number, message: string, headOnly: boolean): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(message));
  response.end(headOnly ? undefined : message);
}

async function serveFile(
  response: ServerResponse,
  filePath: string,
  headOnly: boolean,
): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    response.statusCode = 200;
    response.setHeader("Content-Type", CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream");
    response.setHeader("Content-Length", info.size);
    if (headOnly) {
      response.end();
    } else {
      createReadStream(filePath).on("error", () => response.destroy()).pipe(response);
    }
    return true;
  } catch {
    return false;
  }
}

export function createServer(config: ServerConfig, apiRouter: ApiRouter = emptyApiRouter) {
  const requestListener: RequestListener = async (request, response) => {
    applySecurityHeaders(response);
    const headOnly = request.method === "HEAD";

    try {
      if (await apiRouter(request, response)) return;
      if (request.method !== "GET" && !headOnly) {
        response.setHeader("Allow", "GET, HEAD");
        sendJson(response, 405, {
          error: { code: "method_not_allowed", message: "Method is not allowed for this resource" },
        });
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const decodedPath = decodeURIComponent(url.pathname);
      const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
      const requestedPath = resolve(config.clientDirectory, relativePath);
      const rootPrefix = `${resolve(config.clientDirectory)}${sep}`;

      if (requestedPath.startsWith(rootPrefix) && (await serveFile(response, requestedPath, headOnly))) {
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        const indexPath = resolve(config.clientDirectory, "index.html");
        if (await serveFile(response, indexPath, headOnly)) return;
      }
      sendText(response, 404, "Not found", headOnly);
    } catch {
      sendJson(response, 400, { error: { code: "bad_request", message: "Malformed request" } }, headOnly);
    }
  };

  if (!config.tls.enabled) return createHttpServer(requestListener);

  const requireClientCertificate = config.tls.certificateAuthorityPath !== undefined;
  return createHttpsServer(
    {
      cert: readFileSync(config.tls.certificatePath),
      key: readFileSync(config.tls.privateKeyPath),
      ...(config.tls.certificateAuthorityPath
        ? { ca: readFileSync(config.tls.certificateAuthorityPath) }
        : {}),
      minVersion: "TLSv1.2",
      requestCert: requireClientCertificate,
      rejectUnauthorized: requireClientCertificate,
    },
    requestListener,
  );
}
