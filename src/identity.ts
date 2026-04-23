import * as jose from "jose";
import type { PriorIdentityConfig, PriorIdentityInstance, PriorUser, PriorUserInfo } from "./types.js";

const DEFAULT_ISSUER = "https://api.cg3.io";
const DEFAULT_TOKEN_ENV_VAR = "PRIOR_IDENTITY_TOKEN";

interface OidcDiscoveryDocument {
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
}

function resolveClientId(config: PriorIdentityConfig): string {
  const clientId = config.clientId ?? config.augmentName;
  if (!clientId) {
    throw new Error("createPriorIdentity requires clientId (or legacy augmentName)");
  }
  return clientId;
}

/**
 * Create a Prior Identity validator for your MCP server.
 *
 * ```typescript
 * const identity = createPriorIdentity({ clientId: "my-tool" });
 * const user = await identity.validate(token);
 * ```
 */
export function createPriorIdentity(config: PriorIdentityConfig): PriorIdentityInstance {
  const clientId = resolveClientId(config);
  const {
    issuer = DEFAULT_ISSUER,
    tokenEnvVar = DEFAULT_TOKEN_ENV_VAR,
    onNewUser,
    resolveUser,
  } = config;
  const discoveryUrl = config.discoveryUrl || new URL("/.well-known/openid-configuration", issuer).toString();
  const jwksUrl = config.jwksUrl || new URL("/.well-known/jwks.json", issuer).toString();

  // JWKS key set - jose handles fetching, caching, and rotation automatically.
  let jwks = jose.createRemoteJWKSet(new URL(jwksUrl));
  let discoveryPromise: Promise<OidcDiscoveryDocument | null> | null = null;

  // Track users currently being provisioned (prevents race conditions on concurrent first visits).
  const seenUsers = new Set<string>();
  const pendingUsers = new Set<string>();

  async function loadDiscovery(): Promise<OidcDiscoveryDocument | null> {
    if (!discoveryPromise) {
      discoveryPromise = (async () => {
        try {
          const res = await fetch(discoveryUrl, {
            signal: AbortSignal.timeout(5_000),
          });
          if (!res.ok) return null;
          return await res.json() as OidcDiscoveryDocument;
        } catch {
          return null;
        }
      })();
    }
    return discoveryPromise;
  }

  async function validate(token: string): Promise<PriorUser | null> {
    let payload: jose.JWTPayload;
    try {
      const result = await jose.jwtVerify(token, jwks, {
        issuer,
        audience: clientId,
        algorithms: ["ES256"],
      });
      payload = result.payload;
    } catch (e) {
      if (e instanceof Error) {
        const msg = e.message;
        if (msg.includes("expired")) {
          logDebug("Token rejected: expired");
        } else if (msg.includes("audience")) {
          logDebug(`Token rejected: audience mismatch (expected "${clientId}")`);
        } else if (msg.includes("issuer")) {
          logDebug(`Token rejected: wrong issuer (expected "${issuer}")`);
        } else if (msg.includes("signature")) {
          logDebug("Token rejected: invalid signature (key not in JWKS)");
        } else {
          logDebug(`Token rejected: ${msg}`);
        }
      }
      return null;
    }

    // Accept both the legacy Prior Identity token and the Phase 3 delegated access token.
    const payloadType = typeof payload.type === "string" ? payload.type : "";
    if (payloadType !== "identity" && payloadType !== "access") {
      logDebug(`Token rejected: type "${payload.type}" is not supported`);
      return null;
    }
    if (payloadType === "access") {
      const scopeClaim = typeof payload.scope === "string" ? payload.scope : "";
      if (!scopeClaim.split(" ").includes("identity:read")) {
        logDebug("Token rejected: delegated access token missing identity:read scope");
        return null;
      }
    }
    if (!payload.sub) {
      logDebug('Token rejected: missing "sub" claim');
      return null;
    }
    if (!payload.jti) {
      logDebug('Token rejected: missing "jti" claim');
      return null;
    }

    const user: PriorUser = {
      subject: payload.sub,
      accountId: payload.sub,
      displayName: (payload.name as string) || "User",
      audience: clientId,
      jti: payload.jti,
    };

    if (onNewUser && !seenUsers.has(user.subject) && !pendingUsers.has(user.subject)) {
      pendingUsers.add(user.subject);
      try {
        let isKnown = false;
        if (resolveUser) {
          isKnown = !!(await resolveUser(user.subject));
        }
        if (!isKnown) {
          await onNewUser(user, token);
        }
        seenUsers.add(user.subject);
      } catch (e) {
        logDebug(`onNewUser callback failed for ${user.subject}: ${e instanceof Error ? e.message : e}`);
      } finally {
        pendingUsers.delete(user.subject);
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

  async function getUserInfo(token: string): Promise<PriorUserInfo | null> {
    const userinfoUrl = config.userinfoUrl
      || (await loadDiscovery())?.userinfo_endpoint
      || new URL("/userinfo", issuer).toString();

    try {
      const res = await fetch(userinfoUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      return await res.json() as PriorUserInfo;
    } catch {
      return null;
    }
  }

  async function getEmail(token: string): Promise<string | null> {
    const userinfo = await getUserInfo(token);
    return typeof userinfo?.email === "string" ? userinfo.email : null;
  }

  async function connectInteractiveMethod(options?: {
    timeout?: number;
    authorizeUrl?: string;
    tokenUrl?: string;
    connectUrl?: string;
    exchangeUrl?: string;
    headless?: boolean;
    onUrl?: (url: string) => void;
  }): Promise<PriorUser | null> {
    const { connectInteractive: doConnect } = await import("./connect.js");
    return doConnect(config, validate, options);
  }

  function clearCache(): void {
    jwks = jose.createRemoteJWKSet(new URL(jwksUrl));
    discoveryPromise = null;
  }

  return { validate, validateEnv, getUserInfo, getEmail, connectInteractive: connectInteractiveMethod, clearCache };
}

function logDebug(msg: string): void {
  if (process.env.PRIOR_IDENTITY_DEBUG === "1" || process.env.NODE_ENV === "development") {
    process.stderr.write(`[prior-identity] ${msg}\n`);
  }
}
