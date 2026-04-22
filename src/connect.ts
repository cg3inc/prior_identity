/**
 * Interactive connect flow for non-Equip users.
 *
 * Subpath export: import { connectInteractive } from "@cg3/prior-identity/connect"
 *
 * Resolution order:
 * 1. Check persisted token in ~/.prior/identity/{clientId}.json
 * 2. If expired or missing, open browser for login + consent
 * 3. Receive authorization code via localhost callback
 * 4. Exchange code for delegated access token via PKCE
 * 5. Persist token for next startup
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";
import type { PriorIdentityConfig, PriorUser } from "./types.js";

const DEFAULT_TIMEOUT = 180_000; // 3 minutes

interface OidcDiscoveryDocument {
  authorization_endpoint?: string;
  token_endpoint?: string;
}

export interface ConnectInteractiveOptions {
  timeout?: number;
  authorizeUrl?: string;
  tokenUrl?: string;
  /** @deprecated Use authorizeUrl. */
  connectUrl?: string;
  /** @deprecated Use tokenUrl. */
  exchangeUrl?: string;
  headless?: boolean;
  onUrl?: (url: string) => void;
}

interface PersistedToken {
  clientId: string;
  accessToken?: string;
  /** @deprecated Legacy persisted field name. */
  identityToken?: string;
  accountId: string;
  displayName: string;
  issuedAt: string;
  expiresAt: string;
}

function resolveClientId(config: PriorIdentityConfig): string {
  const clientId = config.clientId ?? config.augmentName;
  if (!clientId) {
    throw new Error("connectInteractive requires clientId (or legacy augmentName)");
  }
  return clientId;
}

function getTokenDir(): string {
  return path.join(os.homedir(), ".prior", "identity");
}

function getTokenPath(clientId: string): string {
  return path.join(getTokenDir(), `${clientId}.json`);
}

function readPersistedToken(clientId: string): PersistedToken | null {
  try {
    const raw = fs.readFileSync(getTokenPath(clientId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writePersistedToken(token: PersistedToken): void {
  const dir = getTokenDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = getTokenPath(token.clientId);
  fs.writeFileSync(filePath, JSON.stringify(token, null, 2));
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows */ }

  const gitignorePath = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    try { fs.writeFileSync(gitignorePath, "*\n"); } catch { /* best effort */ }
  }
}

function isTokenExpired(token: PersistedToken): boolean {
  try {
    return new Date(token.expiresAt).getTime() < Date.now();
  } catch {
    return true;
  }
}

function readPersistedAccessToken(token: PersistedToken): string | null {
  return token.accessToken || token.identityToken || null;
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      childProcess.execSync(`open "${url}"`, { stdio: "ignore" });
    } else if (platform === "win32") {
      childProcess.execSync(`start "" "${url}"`, { stdio: "ignore" });
    } else {
      childProcess.execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    }
  } catch {
    // Browser open failed - headless fallback handled by caller.
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

async function loadDiscovery(config: PriorIdentityConfig): Promise<OidcDiscoveryDocument | null> {
  const issuer = config.issuer || "https://api.cg3.io";
  const discoveryUrl = config.discoveryUrl || new URL("/.well-known/openid-configuration", issuer).toString();

  try {
    const res = await fetch(discoveryUrl, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return await res.json() as OidcDiscoveryDocument;
  } catch {
    return null;
  }
}

export async function connectInteractive(
  config: PriorIdentityConfig,
  validateFn: (token: string) => Promise<PriorUser | null>,
  options: ConnectInteractiveOptions = {},
): Promise<PriorUser | null> {
  const issuer = config.issuer || "https://api.cg3.io";
  const discovery = await loadDiscovery(config);
  const {
    timeout = DEFAULT_TIMEOUT,
    authorizeUrl = options.authorizeUrl
      || options.connectUrl
      || discovery?.authorization_endpoint
      || new URL("/authorize", issuer).toString(),
    tokenUrl = options.tokenUrl
      || options.exchangeUrl
      || discovery?.token_endpoint
      || new URL("/token", issuer).toString(),
    headless = false,
    onUrl,
  } = options;

  const clientId = resolveClientId(config);

  if (!/^[a-zA-Z0-9_-]+$/.test(clientId) || clientId.length > 64) {
    logDebug(`Invalid clientId: "${clientId}"`);
    return null;
  }

  const persisted = readPersistedToken(clientId);
  if (persisted && !isTokenExpired(persisted)) {
    const accessToken = readPersistedAccessToken(persisted);
    const user = accessToken ? await validateFn(accessToken) : null;
    if (user) {
      logDebug(`Using persisted token for "${clientId}"`);
      return user;
    }
  }

  logDebug(`Starting interactive connect for "${clientId}"`);

  const state = crypto.randomBytes(16).toString("hex");
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  return new Promise<PriorUser | null>((resolve) => {
    let resolved = false;
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
      try { server.close(); } catch { /* already closed */ }
    };

    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (returnedState !== state) {
        res.writeHead(403, { "Content-Type": "text/html", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
        res.end("<html><body><h1>Invalid state parameter</h1><p>This request may have been tampered with.</p></body></html>");
        return;
      }

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
        res.end(`<html><body><h1>Connection cancelled</h1><p>${escapeHtml(error)}</p><p>You can close this tab.</p></body></html>`);
        cleanup();
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
        res.end("<html><body><h1>Missing authorization code</h1></body></html>");
        return;
      }

      try {
        const exchangeRes = await fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            code_verifier: codeVerifier,
            redirect_uri: `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`,
            client_id: clientId,
          }).toString(),
          signal: AbortSignal.timeout(10_000),
        });

        const body = await exchangeRes.json() as { access_token?: string; error_description?: string; error?: string };
        if (!body.access_token) {
          res.writeHead(200, { "Content-Type": "text/html", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
          res.end(`<html><body><h1>Connection failed</h1><p>${escapeHtml(body.error_description || body.error || "Unknown error")}</p></body></html>`);
          cleanup();
          return;
        }

        const accessToken = body.access_token;
        const user = await validateFn(accessToken);

        if (!user) {
          res.writeHead(200, { "Content-Type": "text/html", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
          res.end("<html><body><h1>Token validation failed</h1></body></html>");
          cleanup();
          return;
        }

        const claims = decodeJwtPayload(accessToken);
        writePersistedToken({
          clientId,
          accessToken,
          accountId: user.accountId,
          displayName: user.displayName,
          issuedAt: new Date().toISOString(),
          expiresAt: claims?.exp ? new Date((claims.exp as number) * 1000).toISOString() : "",
        });

        res.writeHead(200, { "Content-Type": "text/html", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
        res.end(`<html><body><h1>Connected!</h1><p>Authenticated as <strong>${escapeHtml(user.displayName)}</strong>.</p><p>You can close this tab.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>`);

        resolved = true;
        resolve(user);
        try { server.close(); } catch {}
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<html><body><h1>Error</h1><p>${escapeHtml(e instanceof Error ? e.message : "Unknown error")}</p></body></html>`);
        cleanup();
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const redirectUri = `http://127.0.0.1:${addr.port}/callback`;

      const connectFullUrl = `${authorizeUrl}?` + new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        scope: "identity:read",
      }).toString();

      logDebug(`Listening on ${redirectUri}`);

      if (onUrl) {
        onUrl(connectFullUrl);
      }

      if (!headless) {
        openBrowser(connectFullUrl);
      }

      process.stderr.write(`[prior-identity] To connect, visit: ${connectFullUrl}\n`);
    });

    setTimeout(() => {
      if (!resolved) {
        logDebug(`Connect timed out after ${timeout}ms`);
        cleanup();
      }
    }, timeout).unref();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function logDebug(msg: string): void {
  if (process.env.PRIOR_IDENTITY_DEBUG === "1" || process.env.NODE_ENV === "development") {
    process.stderr.write(`[prior-identity] ${msg}\n`);
  }
}
