/**
 * @cg3/prior-identity — Add user identity to your MCP server in 3 lines.
 *
 * Usage (HTTP):
 *   const identity = createPriorIdentity({ augmentName: "my-tool" });
 *   const user = await identity.validate(bearerToken);
 *   // user = { accountId: "uuid", displayName: "Alice" }
 *
 * Usage (stdio):
 *   const identity = createPriorIdentity({ augmentName: "my-tool" });
 *   const user = await identity.validateEnv();
 *   // reads PRIOR_IDENTITY_TOKEN from env, validates once
 */

export { createPriorIdentity } from "./identity.js";
export type { PriorIdentityConfig, PriorIdentityInstance, PriorUser } from "./types.js";
