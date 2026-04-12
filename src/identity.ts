import * as jose from "jose";
import type { PriorIdentityConfig, PriorIdentityInstance, PriorUser } from "./types.js";

const DEFAULT_JWKS_URL = "https://api.cg3.io/.well-known/jwks.json";
const DEFAULT_ISSUER = "https://api.cg3.io";
const DEFAULT_TOKEN_ENV_VAR = "PRIOR_IDENTITY_TOKEN";

/**
 * Create a Prior Identity validator for your MCP server.
 *
 * ```typescript
 * const identity = createPriorIdentity({ augmentName: "my-tool" });
 * const user = await identity.validate(token);
 * ```
 */
export function createPriorIdentity(config: PriorIdentityConfig): PriorIdentityInstance {
  const {
    augmentName,
    jwksUrl = DEFAULT_JWKS_URL,
    issuer = DEFAULT_ISSUER,
    tokenEnvVar = DEFAULT_TOKEN_ENV_VAR,
    onNewUser,
    resolveUser,
  } = config;

  // JWKS key set — jose handles fetching, caching, and rotation automatically
  let jwks = jose.createRemoteJWKSet(new URL(jwksUrl));

  // Derive /v1/identity/me URL from issuer (respects staging overrides)
  const identityMeUrl = `${issuer}/v1/identity/me`;

  // Track users currently being provisioned (prevents race condition on concurrent first-visits)
  const seenUsers = new Set<string>();
  const pendingUsers = new Set<string>();

  async function validate(token: string): Promise<PriorUser | null> {
    // Verify JWT signature, issuer, audience, and expiry
    let payload: jose.JWTPayload;
    try {
      const result = await jose.jwtVerify(token, jwks, {
        issuer,
        audience: augmentName,
      });
      payload = result.payload;
    } catch (e) {
      // Log actionable error details for publisher debugging
      if (e instanceof Error) {
        const msg = e.message;
        if (msg.includes("expired")) {
          logDebug(`Token rejected: expired`);
        } else if (msg.includes("audience")) {
          logDebug(`Token rejected: audience mismatch (expected "${augmentName}")`);
        } else if (msg.includes("issuer")) {
          logDebug(`Token rejected: wrong issuer (expected "${issuer}")`);
        } else if (msg.includes("signature")) {
          logDebug(`Token rejected: invalid signature (key not in JWKS)`);
        } else {
          logDebug(`Token rejected: ${msg}`);
        }
      }
      return null;
    }

    // Verify this is an identity token with required claims
    if (payload.type !== "identity") {
      logDebug(`Token rejected: type "${payload.type}" is not "identity"`);
      return null;
    }
    if (!payload.sub) {
      logDebug(`Token rejected: missing "sub" claim`);
      return null;
    }
    if (!payload.jti) {
      logDebug(`Token rejected: missing "jti" claim`);
      return null;
    }

    const user: PriorUser = {
      accountId: payload.sub,
      displayName: (payload.name as string) || "User",
      audience: augmentName,
      jti: payload.jti,
    };

    // onNewUser callback with race condition protection
    if (onNewUser && !seenUsers.has(user.accountId) && !pendingUsers.has(user.accountId)) {
      pendingUsers.add(user.accountId); // Mark as in-flight immediately
      try {
        let isKnown = false;
        if (resolveUser) {
          isKnown = !!(await resolveUser(user.accountId));
        }
        if (!isKnown) {
          await onNewUser(user, token);
        }
        seenUsers.add(user.accountId);
      } catch (e) {
        logDebug(`onNewUser callback failed for ${user.accountId}: ${e instanceof Error ? e.message : e}`);
        // Don't add to seenUsers — retry on next request
      } finally {
        pendingUsers.delete(user.accountId);
      }
    }

    return user;
  }

  async function validateEnv(): Promise<PriorUser | null> {
    const token = process.env[tokenEnvVar];
    if (!token) {
      logDebug(`No token found in ${tokenEnvVar} environment variable`);
      return null;
    }
    return validate(token);
  }

  async function getEmail(token: string): Promise<string | null> {
    try {
      const res = await fetch(identityMeUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { ok: boolean; data?: { email?: string } };
      return body.data?.email ?? null;
    } catch {
      return null;
    }
  }

  async function connectInteractiveMethod(options?: {
    timeout?: number;
    connectUrl?: string;
    headless?: boolean;
    onUrl?: (url: string) => void;
  }): Promise<PriorUser | null> {
    // Dynamic import to keep core SDK dependency-free (connect uses node:http)
    const { connectInteractive: doConnect } = await import("./connect.js");
    return doConnect(config, validate, options);
  }

  function clearCache(): void {
    jwks = jose.createRemoteJWKSet(new URL(jwksUrl));
    // Note: seenUsers is intentionally NOT cleared here — it tracks provisioned
    // users, not cached keys. Use clearCache() for JWKS rotation only.
  }

  return { validate, validateEnv, getEmail, connectInteractive: connectInteractiveMethod, clearCache };
}

// Simple debug logger — writes to stderr so it doesn't interfere with MCP stdio transport
function logDebug(msg: string): void {
  if (process.env.PRIOR_IDENTITY_DEBUG === "1" || process.env.NODE_ENV === "development") {
    process.stderr.write(`[prior-identity] ${msg}\n`);
  }
}
