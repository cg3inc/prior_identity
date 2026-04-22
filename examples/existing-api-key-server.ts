/**
 * Example: Adding Prior Identity to an MCP server that already has API key auth.
 *
 * Before Prior Identity, your users had to:
 *   1. Sign up on your website
 *   2. Generate an API key
 *   3. Copy-paste it into their MCP config
 *
 * After: users install via Equip → identity flows automatically → zero manual steps.
 * Existing API key users keep working. New users get auto-provisioned.
 *
 * This example shows a "task tracker" MCP server that already has users + API keys.
 */

import { createPriorIdentity } from "@cg3/prior-identity";

// ── Your existing user model (unchanged) ──────────────────────

interface User {
  id: string;
  email: string;
  apiKeyHash: string;
  priorAccountId?: string; // NEW: linked Prior Identity account
  createdAt: Date;
}

// Simulated database
const users: User[] = [
  { id: "user-1", email: "alice@example.com", apiKeyHash: "hashed_ask_abc123", createdAt: new Date() },
  { id: "user-2", email: "bob@example.com", apiKeyHash: "hashed_ask_def456", createdAt: new Date() },
];

// ── Your existing auth (unchanged) ────────────────────────────

function authenticateByApiKey(apiKey: string): User | null {
  // Your existing API key lookup logic
  const hash = `hashed_${apiKey}`;
  return users.find(u => u.apiKeyHash === hash) || null;
}

// ── Prior Identity setup (3 lines) ────────────────────────────

const identity = createPriorIdentity({
  clientId: "task-tracker",

  // Called on first visit from a new Prior Identity user.
  // The raw token is provided so you can call getEmail() for account linking.
  onNewUser: async (priorUser, token) => {
    // Check if this user already exists by email
    const email = await identity.getEmail(token);
    const existing = email ? users.find(u => u.email === email) : null;

    if (existing) {
      // Link Prior Identity to existing account (user already has an API key)
      existing.priorAccountId = priorUser.accountId;
      console.log(`Linked Prior Identity to existing user ${existing.id} (${email})`);
    } else {
      // Auto-create a new user — no API key needed, Prior Identity is their credential
      const newUser: User = {
        id: `user-${Date.now()}`,
        email: email || "",
        apiKeyHash: "",
        priorAccountId: priorUser.accountId,
        createdAt: new Date(),
      };
      users.push(newUser);
      console.log(`Auto-provisioned user ${newUser.id} from Prior Identity ${priorUser.accountId}`);
    }
  },

  // Check if the Prior accountId is already linked to an existing user
  resolveUser: async (accountId) => {
    return users.find(u => u.priorAccountId === accountId);
  },
});

// ── Unified auth: accepts both API key and Prior Identity ─────

async function authenticate(authHeader: string | undefined): Promise<User | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  // Try Prior Identity first (JWT tokens have dots)
  if (token.includes(".")) {
    const priorUser = await identity.validate(token);
    if (priorUser) {
      // onNewUser callback already created/linked the user — look them up
      const user = users.find(u => u.priorAccountId === priorUser.accountId);
      return user || null;
    }
  }

  // Fall back to existing API key auth
  return authenticateByApiKey(token);
}

// ── Your MCP server tools (unchanged) ─────────────────────────

// ... your existing tool handlers use `user.id` to scope data
// Nothing changes — Prior Identity just provides a new way to get a User object.

/**
 * WHAT CHANGED:
 *
 * 1. Added `@cg3/prior-identity` dependency
 * 2. Added `priorAccountId?: string` to User model
 * 3. Created the `identity` instance (3 lines + callbacks)
 * 4. Updated `authenticate()` to try Prior Identity before API key fallback
 *
 * WHAT DIDN'T CHANGE:
 *
 * - Your User model (just one optional field added)
 * - Your tool handlers (still use `user.id`)
 * - Your API key auth (still works for existing users)
 * - Your database schema (one optional column added)
 *
 * MIGRATION PATH FOR EXISTING USERS:
 *
 * When an existing API key user installs via Equip and gets a Prior Identity token,
 * you can link the accounts by email:
 *
 *   const priorUser = await identity.validate(token);
 *   const email = await identity.getEmail(token);
 *   const existing = users.find(u => u.email === email);
 *   if (existing && !existing.priorAccountId) {
 *     existing.priorAccountId = priorUser.accountId;
 *     // Now they can use either auth method
 *   }
 */
