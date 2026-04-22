/**
 * Example: Adding Prior Identity to an MCP server with no existing auth.
 *
 * This is the simplest integration — you go from "everyone shares one database"
 * to "per-user data isolation" with ~10 lines of code.
 */

import { createPriorIdentity } from "@cg3/prior-identity";

// ── Setup (3 lines) ───────────────────────────────────────────

const identity = createPriorIdentity({ clientId: "my-tool" });

// ── HTTP handler ──────────────────────────────────────────────

async function handleRequest(req: Request): Promise<Response> {
  // Validate identity token
  const token = req.headers.get("Authorization")?.slice(7);
  const user = token ? await identity.validate(token) : null;

  if (!user) {
    return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 });
  }

  // Use user.accountId to scope everything
  // That's it. Per-user data isolation. No signup page. No API key management.
  return new Response(JSON.stringify({ hello: user.displayName, accountId: user.accountId }));
}

// ── Stdio handler ─────────────────────────────────────────────

async function startStdio() {
  const user = await identity.validateEnv();
  if (!user) {
    console.error("Set PRIOR_IDENTITY_TOKEN env var");
    process.exit(1);
  }

  // user.accountId is your per-user scope for the entire session
  console.error(`Authenticated: ${user.displayName} (${user.accountId})`);
}

/**
 * TOTAL INTEGRATION COST:
 *
 * - 1 npm dependency: @cg3/prior-identity
 * - 1 line: createPriorIdentity({ clientId: "my-tool" })
 * - 1 line: await identity.validate(token)  — or validateEnv() for stdio
 * - 0 signup pages, 0 API key management, 0 OAuth configuration
 *
 * WHAT YOU GET:
 *
 * - user.accountId: stable UUID, use as your per-user primary key
 * - user.displayName: human-readable name for UI
 * - identity.getEmail(token): email for account linking (optional, requires API call)
 *
 * WHAT THE USER EXPERIENCES:
 *
 * Install via Equip → done. No browser popup, no API key paste, no "sign up first."
 */
