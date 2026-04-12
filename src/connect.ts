/**
 * Interactive connect flow for non-Equip users.
 *
 * Subpath export: import { connectInteractive } from "@cg3/prior-identity/connect"
 *
 * Resolution order:
 * 1. Check persisted token in ~/.prior/identity/{augmentName}.json
 * 2. If expired or missing, open browser for login + consent
 * 3. Receive authorization code via localhost callback
 * 4. Exchange code for identity token via PKCE
 * 5. Persist token for next startup
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";
import type { PriorIdentityConfig, PriorUser } from "./types.js";

const DEFAULT_CONNECT_URL = "https://prior.cg3.io/identity/connect";
const DEFAULT_EXCHANGE_URL = "https://api.cg3.io/v1/identity/exchange";
const DEFAULT_TIMEOUT = 180_000; // 3 minutes

export interface ConnectInteractiveOptions {
  timeout?: number;
  connectUrl?: string;
  exchangeUrl?: string;
  headless?: boolean;
  onUrl?: (url: string) => void;
}

interface PersistedToken {
  augmentName: string;
  identityToken: string;
  accountId: string;
  displayName: string;
  issuedAt: string;
  expiresAt: string;
}

// ── Token Persistence ──────────────────────────────────────

function getTokenDir(): string {
  return path.join(os.homedir(), ".prior", "identity");
}

function getTokenPath(augmentName: string): string {
  return path.join(getTokenDir(), `${augmentName}.json`);
}

function readPersistedToken(augmentName: string): PersistedToken | null {
  try {
    const raw = fs.readFileSync(getTokenPath(augmentName), "utf-8");
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
  const filePath = getTokenPath(token.augmentName);
  fs.writeFileSync(filePath, JSON.stringify(token, null, 2));
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows */ }

  // Ensure .gitignore exists
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

// ── PKCE ───────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// ── Browser Open ───────────────────────────────────────────

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
    // Browser open failed — headless fallback handled by caller
  }
}

// ── JWT Decode (no verification — just to read claims for persistence) ──

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

// ── Connect Interactive ────────────────────────────────────

export async function connectInteractive(
  config: PriorIdentityConfig,
  validateFn: (token: string) => Promise<PriorUser | null>,
  options: ConnectInteractiveOptions = {},
): Promise<PriorUser | null> {
  const {
    timeout = DEFAULT_TIMEOUT,
    connectUrl = DEFAULT_CONNECT_URL,
    exchangeUrl = options.exchangeUrl || `${config.issuer || "https://api.cg3.io"}/v1/identity/exchange`,
    headless = false,
    onUrl,
  } = options;

  const augmentName = config.augmentName;

  // Validate augmentName before using as filename
  if (!/^[a-zA-Z0-9_-]+$/.test(augmentName) || augmentName.length > 64) {
    logDebug(`Invalid augmentName: "${augmentName}"`);
    return null;
  }

  // 1. Check persisted token
  const persisted = readPersistedToken(augmentName);
  if (persisted && !isTokenExpired(persisted)) {
    const user = await validateFn(persisted.identityToken);
    if (user) {
      logDebug(`Using persisted token for "${augmentName}"`);
      return user;
    }
    // Token invalid (revoked, key rotated) — fall through to browser flow
  }

  // 2. Browser flow
  logDebug(`Starting interactive connect for "${augmentName}"`);

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

    // Start localhost callback server
    const server = http.createServer(async (req, res) => {
      // Only accept requests to /callback
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      // Validate state
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

      // Exchange code for identity token
      try {
        const exchangeRes = await fetch(exchangeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            codeVerifier,
            redirectUri: `http://127.0.0.1:${(server.address() as any).port}/callback`,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        const body = await exchangeRes.json() as any;
        if (!body.ok || !body.data?.token) {
          res.writeHead(200, { "Content-Type": "text/html", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
          res.end(`<html><body><h1>Connection failed</h1><p>${escapeHtml(body.error?.message || "Unknown error")}</p></body></html>`);
          cleanup();
          return;
        }

        const identityToken = body.data.token;
        const user = await validateFn(identityToken);

        if (!user) {
          res.writeHead(200, { "Content-Type": "text/html", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
          res.end("<html><body><h1>Token validation failed</h1></body></html>");
          cleanup();
          return;
        }

        // Persist token
        const claims = decodeJwtPayload(identityToken);
        writePersistedToken({
          augmentName,
          identityToken,
          accountId: user.accountId,
          displayName: user.displayName,
          issuedAt: new Date().toISOString(),
          expiresAt: claims?.exp ? new Date((claims.exp as number) * 1000).toISOString() : "",
        });

        // Success page
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

    // Bind to loopback only, OS-assigned port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const redirectUri = `http://127.0.0.1:${addr.port}/callback`;

      const connectFullUrl = `${connectUrl}?` + new URLSearchParams({
        augment: augmentName,
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();

      logDebug(`Listening on ${redirectUri}`);

      if (onUrl) {
        onUrl(connectFullUrl);
      }

      if (!headless) {
        openBrowser(connectFullUrl);
      }

      // Always print URL to stderr (for headless fallback / debugging)
      process.stderr.write(`[prior-identity] To connect, visit: ${connectFullUrl}\n`);
    });

    // Timeout
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
