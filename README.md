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

User identity for MCP servers. Users authenticate once with [Prior](https://prior.cg3.io); their identity flows to every MCP server that supports it. You validate a JWT and get a stable `accountId` per user. No OAuth implementation, no API key management, no signup pages.

Free for publishers and users.

**What you don't build:** No signup page. No API key generation. No OAuth client registration. No token refresh logic. No session management. No "paste your key here" instructions. No "forgot my API key" support. You call `validate()`. You get a `user`. That's the entire auth surface.

---

## Install

```bash
npm install @cg3/prior-identity
```

Requires Node.js 18+. Single dependency: [`jose`](https://github.com/panva/jose) for JWT/JWKS.

---

## Quick start

### HTTP transport (multi-user servers)

```typescript
import { createPriorIdentity } from "@cg3/prior-identity";

const identity = createPriorIdentity({ augmentName: "my-tool" });

app.post("/mcp", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const user = token ? await identity.validate(token) : null;
  if (!user) return res.status(401).json({ error: "Not authenticated" });

  // user.accountId scopes all data for this request
});
```

### Stdio transport (single-user, local process)

```typescript
import { createPriorIdentity } from "@cg3/prior-identity";

const identity = createPriorIdentity({ augmentName: "my-tool" });

const user = await identity.validateEnv()          // Equip users (zero friction)
  || await identity.connectInteractive();           // Manual users (one-time browser login)

if (!user) { console.error("Could not authenticate."); process.exit(1); }
// user.accountId is your scope for the entire session
```

> **Stdio servers:** Use `console.error()` for logging. In stdio mode, stdout is the MCP JSON-RPC channel.

---

## What your users experience

**Equip users** -- zero prompts. Equip provisions the token automatically when they install your tool, writes it to the MCP config, and refreshes it via a background daemon. They never see an auth screen.

**Manual users** -- one-time browser login. On first start, `connectInteractive()` opens a consent page. User logs in (or creates a free account) and clicks "Allow." The token is saved to `~/.prior/identity/{augmentName}.json`. On subsequent starts, it auto-approves in ~1 second with no click needed.

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

1. User authenticates with Prior (once, via Equip or browser)
2. Prior issues a JWT scoped to your tool (`aud: "my-tool"`)
3. Your server validates the JWT **locally** using Prior's cached public key
4. You get `{ accountId, displayName }` -- use `accountId` as your per-user key

Token verification is local -- the SDK fetches Prior's public key once from `https://api.cg3.io/.well-known/jwks.json` and caches it. No network call per request. Sub-millisecond verification.

Tokens are **audience-bound**. A token issued for `"bookmarks"` is rejected by a server configured as `"code-formatter"`. The `aud` claim is checked automatically.

**1-hour TTL.** Equip's daemon refreshes tokens before expiry. For stdio servers, the token is validated once at startup -- a multi-hour session works fine even after the token technically expires.

---

## Complete example

A working MCP server with per-user data isolation:

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

Verify a Bearer token from an HTTP request. Returns `null` for any invalid token (expired, wrong audience, bad signature, wrong type). Verification is local using cached JWKS keys.

### `identity.validateEnv(): Promise<PriorUser | null>`

Read and validate the token from `PRIOR_IDENTITY_TOKEN` (or custom env var). Returns `null` if the variable is missing or the token is invalid.

### `identity.connectInteractive(options?): Promise<PriorUser | null>`

Browser-based PKCE flow for non-Equip users. Checks `~/.prior/identity/{augmentName}.json` for a persisted token first; opens a browser only if needed. Returns `null` on timeout or cancellation.

Options: `timeout` (default 3 min), `connectUrl`, `headless`, `onUrl`.

### `identity.getEmail(token): Promise<string | null>`

Fetch the user's email via Prior's API. This is a **network call** -- use it sparingly, typically inside `onNewUser` for account linking. Do not call on every request.

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

`validate()` does not consult a revocation list. A revoked token remains valid until it expires (max 1 hour). This is a deliberate tradeoff: local-only verification means zero latency and zero availability dependency on Prior's servers. For tighter revocation, poll `/.well-known/revoked-tokens` and maintain a local blocklist.

### The connect flow (PKCE)

`connectInteractive()` uses a standard PKCE authorization code flow: cryptographic `state` for CSRF prevention, `code_verifier`/`code_challenge` (SHA-256) for proof of possession, and a `127.0.0.1` loopback callback server on an OS-assigned port. The returned token passes through the same `validate()` path before being accepted.

Persisted tokens are written with `0600` permissions on Unix. A `.gitignore` is added to the directory.

### Publisher responsibilities

- **Escape `displayName`** before rendering -- it is user-controlled input
- **Use HTTPS** for HTTP transport servers in production -- tokens are bearer credentials
- **Do not log raw tokens** -- log `user.accountId` instead

---

## Account linking

If your tool already has users (API keys, OAuth), Prior Identity works alongside existing auth:

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

In a multi-provider auth chain, check Prior Identity first -- local JWT verification (~0.3ms) is faster than any network-based auth:

```typescript
const priorUser = await identity.validate(token);
if (priorUser) return await db.users.findByPriorAccountId(priorUser.accountId);
// ...then try OAuth, API keys, etc.
```

---

## Reliability and exit cost

Token validation is local -- cached JWKS keys, no per-request network calls. If Prior goes offline:

- Existing users with valid tokens keep working (up to 1 hour until expiry)
- New token issuance pauses until Prior recovers
- `getEmail()` returns `null`
- Any existing auth you have continues working

**Exit cost is low.** The coupling is JWT verification against a JWKS endpoint. To migrate away, issue your own JWTs with the same claim structure and swap the JWKS URL.

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

Also enabled when `NODE_ENV=development`.

---

## Docs

- **[Publisher Integration Guide](https://cg3.io/docs/identity/publisher-guide)** -- complete setup, transport patterns, account linking, testing
- **[API Reference](https://cg3.io/docs/identity/api-reference)** -- full function signatures, config options, types, environment variables

## License

MIT
