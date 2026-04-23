# @cg3/prior-identity

[![npm version](https://img.shields.io/npm/v/@cg3/prior-identity)](https://www.npmjs.com/package/@cg3/prior-identity)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@cg3/prior-identity)](https://nodejs.org)

Thin CG3 OIDC SDK for MCP publishers. Validate delegated access tokens locally with JWKS, use standard OIDC UserInfo when you need richer identity data, and support both Equip auto-auth and manual PKCE connect.

```typescript
import { createPriorIdentity } from "@cg3/prior-identity";

const identity = createPriorIdentity({ clientId: "my-tool" });
const user = await identity.validate(bearerToken);
// user = { subject: "tool-scoped subject", displayName: "Alice" }
```

Important: the delegated user identifier is pairwise per relying party. `user.subject` is stable for your tool only and must not be used to correlate the same human across different tools.

## Install

```bash
npm install @cg3/prior-identity
```

Requires Node.js 18+.

## Quick start

### HTTP transport

```typescript
import { createPriorIdentity } from "@cg3/prior-identity";

const identity = createPriorIdentity({ clientId: "my-tool" });

async function authenticate(token: string) {
  const priorUser = await identity.validate(token);
  if (priorUser) return { subject: priorUser.subject };

  return await yourExistingAuth(token);
}
```

### Stdio transport

```typescript
import { createPriorIdentity } from "@cg3/prior-identity";

const identity = createPriorIdentity({ clientId: "my-tool" });

const user = await identity.validateEnv()
  || await identity.connectInteractive();

if (!user) {
  console.error("Could not authenticate.");
  process.exit(1);
}
```

## What users experience

Equip users get first-party brokered delegated auth. Equip exchanges the user's CG3 session for a relying-party access token, writes that token into MCP config, and refreshes it in the background.

Manual users go through a standard OIDC auth-code + PKCE flow. `connectInteractive()` opens `/authorize`, the user signs in, explicitly approves the relying party, and the SDK exchanges the code at `/token`. The delegated access token is persisted under `~/.prior/identity/{clientId}.json`.

## How it works

```text
User installs via Equip          User installs manually
        |                                |
  OIDC token exchange             OIDC auth code + PKCE
  writes delegated token          explicit approve / deny
        |                                |
        +--------> MCP Server <----------+
                       |
             identity.validate(token)
                       |
             Local JWT verification
             (ES256, cached JWKS)
                       |
             { subject, displayName }
```

Tokens are audience-bound. A token issued for `"bookmarks"` is rejected by a server configured as `"code-formatter"`.

Verification is local. The SDK caches Prior's JWKS and does not make a network request on every `validate()` call.

## API

### `createPriorIdentity(config)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `clientId` | `string` | required | Your OIDC client / relying-party id. Must match token `aud`. |
| `issuer` | `string` | `https://api.cg3.io` | Expected issuer claim and base for discovery defaults. |
| `discoveryUrl` | `string` | `{issuer}/.well-known/openid-configuration` | Optional override for OIDC discovery. |
| `jwksUrl` | `string` | `{issuer}/.well-known/jwks.json` | Optional override for JWKS verification. |
| `userinfoUrl` | `string` | discovered or `{issuer}/userinfo` | Optional override for OIDC UserInfo. |
| `tokenEnvVar` | `string` | `PRIOR_ACCESS_TOKEN` | Env var for stdio token validation. |
| `onNewUser` | `(user, token) => Promise<void>` | -- | Called on first visit from a new delegated subject. |
| `resolveUser` | `(subject) => Promise<unknown>` | -- | Return truthy to skip `onNewUser` for known users. |

### `identity.validate(token): Promise<PriorUser | null>`

Validates a delegated bearer token locally with cached JWKS.

Required token contract:

- `type="access"`
- `scope` containing `identity:read`

Returns `null` for invalid, expired, wrong-audience, wrong-issuer, or unsupported tokens.

### `identity.validateEnv(): Promise<PriorUser | null>`

Reads the token from `PRIOR_ACCESS_TOKEN` (or your custom env var) and validates it once.

### `identity.getUserInfo(token): Promise<PriorUserInfo | null>`

Calls Prior's standard OIDC UserInfo endpoint. The SDK discovers `userinfo_endpoint` from OIDC metadata unless you override `userinfoUrl`.

Typical response shape:

```typescript
{
  sub: "tool-scoped-subject",
  name: "Alice",
  email: "alice@example.com",
  email_verified: true
}
```

### `identity.getEmail(token): Promise<string | null>`

Convenience helper on top of `getUserInfo()`. Useful for account linking during first-visit provisioning.

### `identity.connectInteractive(options?): Promise<PriorUser | null>`

Node-only browser flow for manual users. Resolution order:

1. Check `~/.prior/identity/{clientId}.json` for a persisted delegated token.
2. If missing or expired, discover OIDC endpoints from the issuer.
3. Open browser for `/authorize` with PKCE.
4. Exchange the returned code at `/token`.
5. Persist the delegated access token for next startup.

Options:

```typescript
{
  timeout?: number;
  authorizeUrl?: string;
  tokenUrl?: string;
  headless?: boolean;
  onUrl?: (url: string) => void;
}
```

### `PriorUser`

```typescript
interface PriorUser {
  subject: string;     // Preferred field for the pairwise delegated subject.
  displayName: string; // Human-readable and mutable.
  audience: string;    // The relying party / client id from `aud`.
  jti: string;         // Unique token id.
}
```

## Security model

Every `validate()` call checks:

- ES256 signature against Prior's JWKS
- `iss`
- `aud`
- `exp`
- delegated access-token family (`type="access"` with `identity:read`)
- required `sub` and `jti`

All of that is local.

### Revocation caveat

This package does not call a revocation endpoint on every request. A revoked token can remain usable until it expires. That is the tradeoff for local-only validation.

### Connect flow

`connectInteractive()` uses a standard auth-code + PKCE loopback flow:

- cryptographic `state` for CSRF protection
- `code_verifier` / `code_challenge` for PKCE
- `127.0.0.1` callback on an OS-assigned port
- token validation through the same `validate()` path before acceptance

## Account linking

For servers with existing users, use `onNewUser` plus `getEmail()` or `getUserInfo()` to link delegated subjects to your own user records:

```typescript
const identity = createPriorIdentity({
  clientId: "my-tool",
  onNewUser: async (priorUser, token) => {
    const email = await identity.getEmail(token);
    const existing = email ? await db.users.findByEmail(email) : null;
    if (existing) {
      await db.users.update(existing.id, { priorSubject: priorUser.subject });
    } else {
      await db.users.create({
        priorSubject: priorUser.subject,
        displayName: priorUser.displayName,
      });
    }
  },
  resolveUser: async (subject) => db.users.findByPriorSubject(subject),
});
```

## Migration and cutover

As of April 22, 2026, the Phase 6 cutover is complete for this SDK surface.

- Supported interactive delegated flow: `/authorize` + `/token` + `/userinfo`
- Supported local validation contract: ES256 delegated `type="access"` token with `scope` containing `identity:read`
- Removed in Phase 6: legacy `type="identity"` token acceptance, `augmentName`, `accountId`, `connectUrl`, `exchangeUrl`, and `PRIOR_IDENTITY_TOKEN`
- Do not build new integrations on `POST /v1/identity/connect`, `POST /v1/identity/exchange`, or `POST /v1/identity/token`

Publisher migration guide and legacy replacement map: [PUBLISHER_MIGRATION.md](./PUBLISHER_MIGRATION.md)

## Reliability and exit cost

If Prior is unavailable:

- existing users with valid cached tokens keep working until token expiry
- new token issuance and manual connect pause
- `getUserInfo()` / `getEmail()` return `null`
- your existing fallback auth can keep working if you have one

Exit cost stays low because the integration is standard JWT validation plus OIDC metadata:

- `iss`
- `aud`
- `sub`
- `exp`
- `jti`
- `type: "access"` with `scope` containing `identity:read`
- optional profile claims such as `name`
