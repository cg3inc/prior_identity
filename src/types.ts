interface PriorIdentityBaseConfig {
  /** OIDC discovery document URL. Default: {issuer}/.well-known/openid-configuration */
  discoveryUrl?: string;

  /** JWKS endpoint URL. Default: {issuer}/.well-known/jwks.json */
  jwksUrl?: string;

  /** Expected JWT issuer. Default: https://api.cg3.io */
  issuer?: string;

  /** OIDC UserInfo endpoint URL. Default: discovered from OIDC metadata or {issuer}/userinfo */
  userinfoUrl?: string;

  /** Env var name for stdio token. Default: PRIOR_IDENTITY_TOKEN */
  tokenEnvVar?: string;

  /**
   * Called when a user is seen for the first time (subject not previously encountered).
   * Use this to auto-provision storage, create a user record, etc.
   * The raw token is provided so you can call getEmail() for account linking.
   */
  onNewUser?: (user: PriorUser, token: string) => Promise<void>;

  /**
   * Called to check if a delegated subject is already known. Return any truthy value to skip onNewUser.
   * If not provided, onNewUser is called on every request (you handle deduplication).
   */
  resolveUser?: (subject: string) => Promise<unknown>;
}

/**
 * Configuration for Prior Identity validation.
 *
 * `clientId` is the OIDC term for the relying party. `augmentName` remains
 * accepted as a backward-compatible alias during the Phase 4 migration window.
 */
export type PriorIdentityConfig =
  | (PriorIdentityBaseConfig & {
      /** Your OIDC client / relying-party id. Must match the token `aud` claim. */
      clientId: string;
      /** @deprecated Use clientId. */
      augmentName?: string;
    })
  | (PriorIdentityBaseConfig & {
      /** @deprecated Use clientId. */
      augmentName: string;
      clientId?: string;
    });

/**
 * A validated Prior Identity user.
 */
export interface PriorUser {
  /** Stable delegated subject for your tool. Treat as opaque; do not assume UUID format. */
  subject: string;

  /** Stable delegated subject for your tool. Treat as opaque; do not assume UUID format. */
  /** @deprecated Use subject. */
  accountId: string;

  /** User's display name. May change over time - don't use as a primary key. */
  displayName: string;

  /** The relying party / client this token was issued for (from the `aud` claim). */
  audience: string;

  /** JWT ID - unique per token issuance. */
  jti: string;
}

/**
 * Standard OIDC userinfo claims returned by Prior.
 */
export interface PriorUserInfo {
  /** Stable delegated subject for this relying party. */
  sub: string;

  /** Human-readable display name. */
  name?: string;

  /** Email address when available and allowed by scope/policy. */
  email?: string;

  /** Whether the email has been verified by the issuer. */
  email_verified?: boolean;

  /** Additional standards-compatible claims may be present. */
  [claim: string]: unknown;
}

/**
 * The Prior Identity instance returned by createPriorIdentity().
 */
export interface PriorIdentityInstance {
  /**
   * Validate a Bearer token (from an HTTP Authorization header).
   * Accepts the legacy identity token plus the delegated OIDC access token when it has identity:read.
   * Returns the user if valid, null if invalid/expired/wrong audience.
   */
  validate(token: string): Promise<PriorUser | null>;

  /**
   * Validate the identity token from an environment variable (stdio transport).
   * Reads from PRIOR_IDENTITY_TOKEN (or custom env var) and validates once.
   * Returns the user if valid, null if missing/invalid.
   */
  validateEnv(): Promise<PriorUser | null>;

  /**
   * Call Prior's standard OIDC UserInfo endpoint.
   * Requires a valid delegated access token. Returns null on failure.
   */
  getUserInfo(token: string): Promise<PriorUserInfo | null>;

  /**
   * Get the user's email address via OIDC UserInfo.
   * Requires a valid delegated access token. Returns null on failure.
   */
  getEmail(token: string): Promise<string | null>;

  /**
   * Interactive browser-based connect flow for non-Equip users.
   *
   * Resolution order:
   * 1. Check persisted token in ~/.prior/identity/{clientId}.json
   * 2. If expired or missing, open browser for OIDC authorize + explicit approval
   * 3. Receive authorization code via localhost callback + PKCE exchange
   *
   * Returns PriorUser on success, null on timeout/cancel.
   * Only works in Node.js (uses node:http for localhost callback server).
   */
  connectInteractive(options?: {
    timeout?: number;
    authorizeUrl?: string;
    tokenUrl?: string;
    /** @deprecated Use authorizeUrl. */
    connectUrl?: string;
    /** @deprecated Use tokenUrl. */
    exchangeUrl?: string;
    headless?: boolean;
    onUrl?: (url: string) => void;
  }): Promise<PriorUser | null>;

  /**
   * Clear the JWKS cache. Useful for testing or after key rotation.
   */
  clearCache(): void;
}
