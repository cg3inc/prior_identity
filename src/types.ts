/**
 * Configuration for Prior Identity validation.
 */
export interface PriorIdentityConfig {
  /** Your augment's name — must match the `aud` claim in the identity token. */
  augmentName: string;

  /** JWKS endpoint URL. Default: https://api.cg3.io/.well-known/jwks.json */
  jwksUrl?: string;

  /** Expected JWT issuer. Default: https://api.cg3.io */
  issuer?: string;

  /** Env var name for stdio token. Default: PRIOR_IDENTITY_TOKEN */
  tokenEnvVar?: string;

  /**
   * Called when a user is seen for the first time (accountId not previously encountered).
   * Use this to auto-provision storage, create a user record, etc.
   * The raw token is provided so you can call getEmail() for account linking.
   */
  onNewUser?: (user: PriorUser, token: string) => Promise<void>;

  /**
   * Called to check if an accountId is already known. Return any truthy value to skip onNewUser.
   * If not provided, onNewUser is called on every request (you handle deduplication).
   */
  resolveUser?: (accountId: string) => Promise<unknown>;
}

/**
 * A validated Prior Identity user.
 */
export interface PriorUser {
  /** Stable account identifier (UUID). Use this to scope per-user data. */
  accountId: string;

  /** User's display name. May change over time — don't use as a primary key. */
  displayName: string;

  /** The augment this token was issued for (from the `aud` claim). */
  audience: string;

  /** JWT ID — unique per token issuance. */
  jti: string;
}

/**
 * The Prior Identity instance returned by createPriorIdentity().
 */
export interface PriorIdentityInstance {
  /**
   * Validate a Bearer token (from an HTTP Authorization header).
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
   * Get the user's email address by calling Prior's /v1/identity/me endpoint.
   * Requires a valid identity token. Returns null on failure.
   */
  getEmail(token: string): Promise<string | null>;

  /**
   * Interactive browser-based connect flow for non-Equip users.
   *
   * Resolution order:
   * 1. Check persisted token in ~/.prior/identity/{augmentName}.json
   * 2. If expired or missing, open browser for login + consent
   * 3. Receive authorization code via localhost callback + PKCE exchange
   *
   * Returns PriorUser on success, null on timeout/cancel.
   * Only works in Node.js (uses node:http for localhost callback server).
   */
  connectInteractive(options?: {
    timeout?: number;
    connectUrl?: string;
    headless?: boolean;
    onUrl?: (url: string) => void;
  }): Promise<PriorUser | null>;

  /**
   * Clear the JWKS cache. Useful for testing or after key rotation.
   */
  clearCache(): void;
}
