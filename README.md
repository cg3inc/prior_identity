# @cg3/prior-identity

[![npm version](https://img.shields.io/npm/v/@cg3/prior-identity)](https://www.npmjs.com/package/@cg3/prior-identity)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@cg3/prior-identity)](https://nodejs.org)

```typescript
import { createPriorIdentity } from "@cg3/prior-identity";

const identity = createPriorIdentity({ augmentName: "my-tool" });
const user = await identity.validate(bearerToken);
// user = { accountId: "uuid", displayName: "Alice" }
```

User identity for MCP servers. Add ~10 lines — [Equip](https://cg3.io/equip) users get zero-prompt auth on top of whatever you already ship. Existing API-key or OAuth users keep working unchanged. Prior Identity is an additive layer, not a replacement.

Local JWT verification via cached JWKS — sub-millisecond on typical hardware, no network per request. You call `validate()`, you get a stable `accountId` per user, you use it as your per-user scope.

Free for publishers and users.

**What Equip users never see:** signup pages, API key paste boxes, OAuth consent screens, "forgot my API key" support tickets. Adoption is a branch you add to your existing auth chain, not a migration.

## Who this is for

Augment publishers who want per-user auth without shipping a signup flow. MCP server authors today; any future augment type that grows a user-facing auth surface fits the same model. If your tool has users, Prior Identity is for you.

Three integration patterns cover the common starting points, all worked out in [`examples/`](./examples):

- **No existing auth** — [`no-auth-server.ts`](./examples/no-auth-server.ts). Your server had no user concept; Prior Identity adds per-user isolation with ~10 lines.
- **Existing API keys** — [`existing-api-key-server.ts`](./examples/existing-api-key-server.ts). `authenticate()` tries Prior first (JWT tokens have dots), falls back to your API key check. `onNewUser` links accounts by email.
- **Existing OAuth** — [`existing-oauth-server.ts`](./examples/existing-oauth-server.ts). Prior goes first in the chain (local crypto, sub-millisecond) before any network-based OAuth verification.

In all three, existing users keep working and new Equip users flow in without prompts. You don't migrate anything.

---

## Install

```bash
npm install @cg3/prior-identity
```

Requires Node.js 18+. Single dependency: [`jose`](https://github.com/panva/jose) for JWT/JWKS.

---

## Quick start

### HTTP transport — alongside existing auth

```typescript
import { createPriorIdentity } from "@cg3/prior-identity";

const identity = createPriorIdentity({ augmentName: "my-tool" });

async function authenticate(token: string) {
  // Try Prior Identity first — local JWT crypto, no network call
  const priorUser = await identity.validate(token);
  if (priorUser) return { accountId: priorUser.accountId };

  // Fall through to whatever auth you already have
  return await yourExistingAuth(token);
}
```

No existing auth? Drop the fallback — check `priorUser`, 401 on miss. See [`examples/no-auth-server.ts`](./examples/no-auth-server.ts).

### Stdio transport — single-user, local process

```typescript
import { createPriorIdentity } from "@cg3/prior-identity";

const identity = createPriorIdentity({ augmentName: "my-tool" });

const user = await identity.validateEnv()          // Equip users — zero friction
  || await identity.connectInteractive();           // Manual users — one-time browser login
  // || yourExistingApiKeyAuth()                    // or fall through to your existing auth

if (!user) { console.error("Could not authenticate."); process.exit(1); }
// user.accountId is your scope for the entire session
```

> **Stdio servers:** Use `console.error()` for logging. In stdio mode, stdout is the MCP JSON-RPC channel.

---

## What your users experience

**Equip users** -- zero prompts. Equip provisions the token automatically when they install your tool, writes it to the MCP config, and refreshes it via a background daemon. They never see an auth screen.

**Manual users** -- one-time browser login. On first start, `connectInteractive()` opens a consent page. User logs in (or creates a free account) and clicks "Allow." The token is saved to `~/.prior/identity/{augmentName}.json`. On subsequent starts, the SDK reads the persisted token and validates it locally — no browser, no prompt.

---

## How it works

```
User installs via Equip          User installs manually
        |                                |
  Equip provisions token          Browser login + consent
  writes to MCP config            (one-time, auto-approved on reconnect)
        |                                |
        +--------> MCP Server <----------+
                       |
             identity.validate(token)
                       |
             Local JWT verification
             (ES256, cached JWKS key)
                       |
             { accountId, displayName }
```

**Tokens are audience-bound.** A token issued for `"bookmarks"` is rejected by a server configured as `"code-formatter"`. The `aud` claim is checked automatically on every `validate()` call.

**Verification is local.** The SDK fetches Prior's public key once from `https://api.cg3.io/.well-known/jwks.json` and caches it — no per-request network call. Sub-millisecond on typical hardware.

**1-hour TTL.** Equip's daemon refreshes tokens before expiry. For stdio servers, the token is validated once at startup (at the `validateEnv()` call), so in-process session state is not re-checked — a multi-hour session works fine even after the original token technically expires.

---

## Complete example

A working MCP server with per-user data isolation (illustrative — `better-sqlite3` stands in for whatever storage you use):

```typescript
import { createPriorIdentity } from "@cg3/prior-identity";
import Database from "better-sqlite3";

// Identity (3 lines)
const identity = createPriorIdentity({ augmentName: "bookmarks" });
const user = await identity.validateEnv() || await identity.connectInteractive();
if (!user) { console.error("Could not authenticate."); process.exit(1); }

// Database (scoped by user)
const db = new Database("bookmarks.db");
db.exec(`CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY, user_id TEXT, url TEXT, title TEXT
)`);

// Every query uses user.accountId -- no shared state between users
db.prepare("INSERT INTO bookmarks (user_id, url, title) VALUES (?, ?, ?)")
  .run(user.accountId, "https://example.com", "Example");

const mine = db.prepare("SELECT * FROM bookmarks WHERE user_id = ?")
  .all(user.accountId);
```

---

## API

### `createPriorIdentity(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `augmentName` | `string` | *required* | Your registered augment name. Tokens are audience-bound to this value. |
| `jwksUrl` | `string` | `https://api.cg3.io/.well-known/jwks.json` | JWKS endpoint for key verification. |
| `issuer` | `string` | `https://api.cg3.io` | Expected JWT issuer claim. |
| `tokenEnvVar` | `string` | `PRIOR_IDENTITY_TOKEN` | Env var for stdio token. |
| `onNewUser` | `(user, token) => Promise<void>` | -- | Called on first visit from a new accountId. |
| `resolveUser` | `(accountId) => Promise<unknown>` | -- | Return truthy to skip `onNewUser` for known users. |

### `identity.validate(token): Promise<PriorUser | null>`

Verify a Bearer token from an HTTP request. Returns `null` for any invalid token — expired, wrong audience, wrong issuer, bad signature, wrong algorithm, wrong type, or missing required claims (`sub`, `jti`). Verification is local using cached JWKS keys.

### `identity.validateEnv(): Promise<PriorUser | null>`

Read and validate the token from `PRIOR_IDENTITY_TOKEN` (or custom env var). Returns `null` if the variable is missing or the token is invalid.

### `identity.connectInteractive(options?): Promise<PriorUser | null>`

Browser-based PKCE flow for non-Equip users. Checks `~/.prior/identity/{augmentName}.json` for a persisted token first; opens a browser only if needed. Returns `null` on timeout or cancellation.

Options: `timeout` (default 3 min), `connectUrl`, `headless`, `onUrl`.

### `identity.getEmail(token): Promise<string | null>`

Fetch the user's email via Prior's API (`${issuer}/v1/identity/me` — respects the `issuer` config override, so staging redirects here too). This is a **network call** -- use it sparingly, typically inside `onNewUser` for account linking. Do not call on every request.

### `identity.clearCache(): void`

Force re-fetch of JWKS keys on next validation.

### `PriorUser`

```typescript
interface PriorUser {
  accountId: string;    // Stable UUID -- your per-user primary key
  displayName: string;  // Human-readable, may change over time
  audience: string;     // The augmentName this token was issued for
  jti: string;          // Unique token ID
}
```

---

## Security model

### What's verified on every `validate()` call

- **ES256 signature** -- token was signed by Prior's private key (ECDSA P-256), verified against the cached JWKS public key
- **Issuer** -- `iss` must match `https://api.cg3.io`
- **Audience** -- `aud` must match your `augmentName`, preventing cross-tool token reuse
- **Expiry** -- `exp` checked against system clock
- **Token type** -- `type` must be `"identity"`, rejecting other Prior JWT types

All checks are local. No network call to Prior per request.

### Revocation caveat

`validate()` does not consult a revocation list. A revoked token remains valid until it expires (max 1 hour). This is a deliberate tradeoff: local-only verification means zero latency and zero availability dependency on Prior's servers. For tighter revocation, poll `/.well-known/revoked-tokens?augment=<yourAugmentName>` (the `augment` filter scopes the response to tokens that could affect you) and maintain a local blocklist.

### The connect flow (PKCE)

`connectInteractive()` uses a standard PKCE authorization code flow: cryptographic `state` for CSRF prevention, `code_verifier`/`code_challenge` (SHA-256) for proof of possession, and a `127.0.0.1` loopback callback server on an OS-assigned port. The returned token passes through the same `validate()` path before being accepted.

Persisted tokens are written with `0600` permissions on Unix. A `.gitignore` is added to the directory.

### Publisher responsibilities

- **Escape `displayName`** before rendering -- it is user-controlled input
- **Use HTTPS** for HTTP transport servers in production -- tokens are bearer credentials
- **Do not log raw tokens** -- log `user.accountId` instead

---

## Account linking

For servers with existing users, the `onNewUser` / `resolveUser` callbacks let you attach a Prior `accountId` to your existing user records on first visit — typically by email:

```typescript
const identity = createPriorIdentity({
  augmentName: "my-tool",
  onNewUser: async (priorUser, token) => {
    const email = await identity.getEmail(token);
    const existing = email ? await db.users.findByEmail(email) : null;
    if (existing) {
      await db.users.update(existing.id, { priorAccountId: priorUser.accountId });
    } else {
      await db.users.create({ priorAccountId: priorUser.accountId, displayName: priorUser.displayName });
    }
  },
  resolveUser: async (accountId) => db.users.findByPriorAccountId(accountId),
});
```

After linking, both auth methods resolve to the same user record. See the Quick start above for the chain-order pattern (Prior first, existing auth as fallback), and [`examples/existing-api-key-server.ts`](./examples/existing-api-key-server.ts) + [`examples/existing-oauth-server.ts`](./examples/existing-oauth-server.ts) for full working integrations.

---

## Reliability and exit cost

Token validation is local -- cached JWKS keys, no per-request network calls. If Prior goes offline:

- Existing users with valid tokens keep working (up to 1 hour until expiry)
- New token issuance pauses until Prior recovers
- `getEmail()` returns `null`
- Any existing auth you have continues working

**Exit cost is low.** The coupling is JWT verification against a JWKS endpoint. To migrate away, issue your own JWTs with the same claim structure and swap the JWKS URL. The claim set is: `iss`, `aud` (your `augmentName`), `sub` (accountId), `exp`, `jti`, `type: "identity"`, and optionally `name` (displayName). Signed with ES256.

---

## Token details

| Property | Value |
|----------|-------|
| Algorithm | ES256 (ECDSA P-256) |
| TTL | 1 hour |
| Issuer | `https://api.cg3.io` |
| JWKS | `https://api.cg3.io/.well-known/jwks.json` |
| Audience | Your `augmentName` |
| Scope | `identity:read` |

For non-Node environments (Python, Go, etc.), verify tokens with any JWT library that supports ES256 + JWKS. Check `iss`, `aud`, `exp`, and `type` (must be `"identity"`).

---

## Getting started

1. **Create a free creator profile** at [cg3.io/equip/create](https://cg3.io/equip/create) (~30 seconds, GitHub/Google/Discord login)
2. **Register your augment name** (claimed, unique -- prevents impersonation)
3. `npm install @cg3/prior-identity`
4. Follow the **[Publisher Integration Guide](https://cg3.io/docs/identity/publisher-guide)** for step-by-step setup

For local development, the SDK works without registration. Production token issuance requires a registered name.

---

## Debug mode

```bash
PRIOR_IDENTITY_DEBUG=1 node my-server.js
```

Shows exactly why tokens are rejected:

```
[prior-identity] Token rejected: audience mismatch (expected "my-tool")
[prior-identity] Token rejected: expired
[prior-identity] Token rejected: invalid signature (key not in JWKS)
```

Debug output is written to stderr — safe to enable in stdio MCP servers without corrupting the stdout JSON-RPC channel.

Also enabled when `NODE_ENV=development`.

---

## Docs

- **[Publisher Integration Guide](https://cg3.io/docs/identity/publisher-guide)** -- complete setup, transport patterns, account linking, testing
- **[API Reference](https://cg3.io/docs/identity/api-reference)** -- full function signatures, config options, types, environment variables

## License

MIT
