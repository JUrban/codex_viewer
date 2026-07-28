import type { IncomingMessage, ServerResponse } from "node:http";

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
} as const;

export function applySecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

function isLocalAuthority(authority: string): boolean {
  try {
    const url = new URL(`http://${authority}`);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

export function validateRequestSource(request: IncomingMessage): string | null {
  const host = request.headers.host;
  if (!host || !isLocalAuthority(host)) return "invalid_host";

  const origin = request.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (
        originUrl.protocol !== "http:" ||
        !isLocalAuthority(originUrl.host) ||
        originUrl.host !== host.toLowerCase()
      ) {
        return "invalid_origin";
      }
    } catch {
      return "invalid_origin";
    }
  }
  return null;
}
