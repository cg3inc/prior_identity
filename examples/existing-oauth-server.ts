/**
 * Example: Adding Prior Identity branded OIDC delegated auth to an MCP server
 * that already has OAuth.
 */

import { createPriorIdentity } from "@cg3/prior-identity";

interface User {
  id: string;
  email: string;
  displayName: string;
  githubId?: string;
  googleId?: string;
  priorSubject?: string;
  createdAt: Date;
}

const users: User[] = [
  { id: "user-1", email: "alice@dev.com", displayName: "Alice", githubId: "gh-12345", createdAt: new Date() },
  { id: "user-2", email: "bob@dev.com", displayName: "Bob", googleId: "g-67890", createdAt: new Date() },
];

async function verifyGitHubToken(token: string): Promise<{ githubId: string; email: string } | null> {
  return null;
}

async function verifyGoogleToken(token: string): Promise<{ googleId: string; email: string } | null> {
  return null;
}

const identity = createPriorIdentity({
  clientId: "docs-search",

  onNewUser: async (priorUser, token) => {
    const email = await identity.getEmail(token);
    const existing = email ? users.find(u => u.email === email) : null;

    if (existing) {
      existing.priorSubject = priorUser.subject;
      console.log(`Linked delegated subject ${priorUser.subject} to existing user ${existing.id}`);
    } else {
      const newUser: User = {
        id: `user-${Date.now()}`,
        email: email || "",
        displayName: priorUser.displayName,
        priorSubject: priorUser.subject,
        createdAt: new Date(),
      };
      users.push(newUser);
      console.log(`Created new user ${newUser.id} from delegated auth`);
    }
  },

  resolveUser: async (subject) => {
    return users.find(u => u.priorSubject === subject);
  },
});

async function authenticate(authHeader: string | undefined): Promise<User | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const priorUser = await identity.validate(token);
  if (priorUser) {
    return users.find(u => u.priorSubject === priorUser.subject) || null;
  }

  const githubUser = await verifyGitHubToken(token);
  if (githubUser) {
    return users.find(u => u.githubId === githubUser.githubId) || null;
  }

  const googleUser = await verifyGoogleToken(token);
  if (googleUser) {
    return users.find(u => u.googleId === googleUser.googleId) || null;
  }

  return null;
}
