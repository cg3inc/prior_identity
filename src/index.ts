/**
 * @cg3/prior-identity - Add user identity to your MCP server in 3 lines.
 *
 * Usage (HTTP):
 *   const identity = createPriorIdentity({ clientId: "my-tool" });
 *   const user = await identity.validate(bearerToken);
 *   // user = { subject: "opaque-subject", accountId: "opaque-subject", displayName: "Alice" }
 *
 * Usage (stdio):
 *   const identity = createPriorIdentity({ clientId: "my-tool" });
 *   const user = await identity.validateEnv();
 *   // reads PRIOR_IDENTITY_TOKEN from env, validates once
 */

export { createPriorIdentity } from "./identity.js";
export type { PriorIdentityConfig, PriorIdentityInstance, PriorUser, PriorUserInfo } from "./types.js";
