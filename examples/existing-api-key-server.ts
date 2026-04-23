/**
 * Example: Adding Prior Identity branded OIDC delegated auth to an MCP server
 * that already has API key auth.
 *
 * Before delegated auth, your users had to:
 *   1. Sign up on your website
 *   2. Generate an API key
 *   3. Copy-paste it into their MCP config
 *
 * After: users install via Equip, delegated auth flows automatically, and
 * there are zero manual auth steps. Existing API key users keep working.
 */

import { createPriorIdentity } from "@cg3/prior-identity";

interface User {
  id: string;
  email: string;
  apiKeyHash: string;
  priorSubject?: string;
  createdAt: Date;
}

const users: User[] = [
  { id: "user-1", email: "alice@example.com", apiKeyHash: "hashed_ask_abc123", createdAt: new Date() },
  { id: "user-2", email: "bob@example.com", apiKeyHash: "hashed_ask_def456", createdAt: new Date() },
];

function authenticateByApiKey(apiKey: string): User | null {
  const hash = `hashed_${apiKey}`;
  return users.find(u => u.apiKeyHash === hash) || null;
}

const identity = createPriorIdentity({
  clientId: "task-tracker",

  // Called on first visit from a new delegated-auth user.
  onNewUser: async (priorUser, token) => {
    const email = await identity.getEmail(token);
    const existing = email ? users.find(u => u.email === email) : null;

    if (existing) {
      existing.priorSubject = priorUser.subject;
      console.log(`Linked delegated subject to existing user ${existing.id} (${email})`);
    } else {
      const newUser: User = {
        id: `user-${Date.now()}`,
        email: email || "",
        apiKeyHash: "",
        priorSubject: priorUser.subject,
        createdAt: new Date(),
      };
      users.push(newUser);
      console.log(`Auto-provisioned user ${newUser.id} from delegated subject ${priorUser.subject}`);
    }
  },

  resolveUser: async (subject) => {
    return users.find(u => u.priorSubject === subject);
  },
});

async function authenticate(authHeader: string | undefined): Promise<User | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  // Try delegated user auth first (JWT tokens have dots).
  if (token.includes(".")) {
    const priorUser = await identity.validate(token);
    if (priorUser) {
      return users.find(u => u.priorSubject === priorUser.subject) || null;
    }
  }

  return authenticateByApiKey(token);
}

// Your MCP handlers can keep using `user.id` to scope product-local data.
