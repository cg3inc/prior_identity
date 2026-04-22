/**
 * Example: Adding Prior Identity to an MCP server that already has OAuth.
 *
 * Before Prior Identity, your users had to:
 *   1. Click "Sign in with GitHub" in a browser popup
 *   2. Approve OAuth consent
 *   3. Wait for redirect back to your app
 *   4. Token written to MCP config
 *
 * After: users install via Equip → identity flows automatically → zero prompts.
 * Existing OAuth users keep working. Prior Identity is just another provider.
 *
 * This example shows a "docs search" MCP server with GitHub OAuth + Prior Identity.
 */

import { createPriorIdentity } from "@cg3/prior-identity";

// ── Your existing user model ──────────────────────────────────

interface User {
  id: string;
  email: string;
  displayName: string;
  // Linked identity providers — add Prior alongside existing ones
  githubId?: string;
  googleId?: string;
  priorAccountId?: string; // NEW
  createdAt: Date;
}

const users: User[] = [
  { id: "user-1", email: "alice@dev.com", displayName: "Alice", githubId: "gh-12345", createdAt: new Date() },
  { id: "user-2", email: "bob@dev.com", displayName: "Bob", googleId: "g-67890", createdAt: new Date() },
];

// ── Your existing OAuth verification ──────────────────────────

async function verifyGitHubToken(token: string): Promise<{ githubId: string; email: string } | null> {
  // Your existing GitHub OAuth token verification
  // Call GitHub API, validate token, get user info
  return null; // simplified for example
}

async function verifyGoogleToken(token: string): Promise<{ googleId: string; email: string } | null> {
  // Your existing Google OAuth token verification
  return null;
}

// ── Prior Identity setup ──────────────────────────────────────

const identity = createPriorIdentity({
  clientId: "docs-search",

  onNewUser: async (priorUser, token) => {
    // Try to link to an existing user by email
    const email = await identity.getEmail(token);
    const existing = email ? users.find(u => u.email === email) : null;

    if (existing) {
      // Link Prior Identity to existing account
      existing.priorAccountId = priorUser.accountId;
      console.log(`Linked Prior Identity ${priorUser.accountId} to existing user ${existing.id}`);
    } else {
      // Create new user from Prior Identity
      const newUser: User = {
        id: `user-${Date.now()}`,
        email: email || "",
        displayName: priorUser.displayName,
        priorAccountId: priorUser.accountId,
        createdAt: new Date(),
      };
      users.push(newUser);
      console.log(`Created new user ${newUser.id} from Prior Identity`);
    }
  },

  resolveUser: async (accountId) => {
    return users.find(u => u.priorAccountId === accountId);
  },
});

// ── Unified auth: accepts Prior Identity, GitHub, and Google ──

async function authenticate(authHeader: string | undefined): Promise<User | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  // 1. Try Prior Identity (fast — local JWT verification via JWKS, no network call)
  const priorUser = await identity.validate(token);
  if (priorUser) {
    const user = users.find(u => u.priorAccountId === priorUser.accountId);
    return user || null; // onNewUser already created/linked the user
  }

  // 2. Try GitHub OAuth
  const githubUser = await verifyGitHubToken(token);
  if (githubUser) {
    return users.find(u => u.githubId === githubUser.githubId) || null;
  }

  // 3. Try Google OAuth
  const googleUser = await verifyGoogleToken(token);
  if (googleUser) {
    return users.find(u => u.googleId === googleUser.googleId) || null;
  }

  return null;
}

/**
 * WHAT CHANGED:
 *
 * 1. Added `@cg3/prior-identity` dependency
 * 2. Added `priorAccountId?: string` to User model (same pattern as githubId/googleId)
 * 3. Created the `identity` instance with account linking callbacks
 * 4. Added Prior Identity as the first check in `authenticate()`
 *
 * WHY PRIOR IDENTITY GOES FIRST:
 *
 * Prior Identity verification is pure local JWT crypto — ~0.3ms, zero network calls.
 * GitHub/Google OAuth verification requires an HTTP call to their API — ~100-300ms.
 * Checking Prior first means Equip users get the fastest possible auth path.
 *
 * ACCOUNT LINKING STRATEGY:
 *
 * When a Prior Identity user first visits:
 *   1. SDK calls `getEmail()` → gets the user's email from Prior
 *   2. Look up existing user by email
 *   3. If found: link `priorAccountId` to their existing account
 *   4. If not: create a new account
 *
 * This means:
 *   - A user who signed in with GitHub before AND installs via Equip
 *     → gets linked to their existing account automatically (by email match)
 *   - They can then use either auth method
 *   - Their data follows them across both paths
 *
 * WHAT IF EMAILS DON'T MATCH?
 *
 * If the user's Prior email differs from their GitHub email, they'll get
 * a new account. You can add a manual linking flow in your settings UI:
 * "Link your Prior Identity account" → user proves ownership of both.
 */
