/**
 * Example: Adding Prior Identity branded OIDC delegated auth to an MCP server
 * with no existing auth.
 */

import { createPriorIdentity } from "@cg3/prior-identity";

const identity = createPriorIdentity({ clientId: "my-tool" });

async function handleRequest(req: Request): Promise<Response> {
  const token = req.headers.get("Authorization")?.slice(7);
  const user = token ? await identity.validate(token) : null;

  if (!user) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 });
  }

  return new Response(JSON.stringify({ hello: user.displayName, subject: user.subject }));
}

async function startStdio() {
  const user = await identity.validateEnv();
  if (!user) {
    console.error("Set PRIOR_ACCESS_TOKEN env var");
    process.exit(1);
  }

  console.error(`Authenticated: ${user.displayName} (${user.subject})`);
}
