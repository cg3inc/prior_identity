# CG3 OIDC Publisher Migration

This guide is for publishers moving from the legacy Prior Identity delegated-auth protocol to the supported OAuth/OIDC contract.

## Use this for new integrations

1. Register or obtain your CG3 relying-party `clientId`.
2. Send users through `/authorize` with PKCE.
3. Exchange the returned code at `/token`.
4. Validate the delegated access token locally with JWKS.
5. Call `/userinfo` when you need richer identity data such as email.

If you use `@cg3/prior-identity`, the SDK handles discovery, JWKS validation, `connectInteractive()`, and `/userinfo` for you.

## Legacy replacement map

| Legacy surface | Supported replacement |
| --- | --- |
| `POST /v1/identity/connect` | `GET /authorize` with PKCE |
| `POST /v1/identity/exchange` | `POST /token` |
| `POST /v1/identity/token` | No direct replacement. Use auth-code or first-party token-exchange flows on `/token` instead. |
| `GET /v1/identity/me` for delegated user profile | `GET /userinfo` |
| legacy `type="identity"` token | delegated OIDC `type="access"` token with `identity:read` |

## Identity model changes

- The delegated identifier is now pairwise per relying party.
- In `@cg3/prior-identity`, prefer `user.subject` for new storage.
- Do not use the delegated subject to correlate the same human across different tools.

## Legacy behaviors not carried forward in the current SDK

- legacy `type="identity"` token validation
- `augmentName` config alias
- `user.accountId` compatibility alias
- `connectUrl` / `exchangeUrl` option aliases
- `PRIOR_IDENTITY_TOKEN` as the default stdio env-var name

Use `clientId`, `user.subject`, `authorizeUrl`, `tokenUrl`, and `PRIOR_ACCESS_TOKEN`.

## What stays API-key-based

- Durable unattended machine auth
- Existing machine-to-machine workflows that do not represent a delegated human session

## What moves to OIDC

- Manual publisher connect
- Browser-based human sign-in for CG3-maintained clients
- Publisher token validation and profile lookup

## Minimum publisher checklist

- Request `identity:read` for delegated access.
- Validate `iss`, `aud`, `exp`, and signature locally.
- Treat the delegated subject as opaque.
- Use `/userinfo` rather than older delegated profile endpoints.
- Keep product grants coarse; do not encode entitlements or billing tiers as OIDC scopes.
