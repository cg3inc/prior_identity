import { createServer } from "node:http";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as jose from "jose";

let privateKey;

before(async () => {
  const kp = await jose.generateKeyPair("ES256");
  privateKey = kp.privateKey;
});

async function createToken(claims = {}, options = {}) {
  const builder = new jose.SignJWT({
    name: "Alice",
    scope: "identity:read",
    type: "access",
    ...claims,
  })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(options.issuer || "https://api.cg3.io")
    .setJti(claims.jti || "jti-abc")
    .setAudience(options.audience !== undefined ? options.audience : "codenotes")
    .setExpirationTime(options.exp || "1h");

  if (!Object.prototype.hasOwnProperty.call(claims, "sub")) {
    builder.setSubject("account-123");
  } else if (typeof claims.sub === "string") {
    builder.setSubject(claims.sub);
  }

  return builder.sign(privateKey);
}

async function withLocalOidcIssuer(options, fn) {
  const pubJwk = options.keyPair ? await jose.exportJWK(options.keyPair.publicKey) : null;
  if (pubJwk) {
    pubJwk.kid = "local-test-key";
    pubJwk.alg = "ES256";
    pubJwk.use = "sig";
  }

  const server = createServer((req, res) => {
    const baseUrl = `http://${req.headers.host}`;

    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        issuer: baseUrl,
        jwks_uri: `${baseUrl}/.well-known/jwks.json`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        userinfo_endpoint: `${baseUrl}/userinfo`,
      }));
      return;
    }

    if (req.url === "/.well-known/jwks.json" && pubJwk) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [pubJwk] }));
      return;
    }

    if (options.onRequest) {
      options.onRequest(req, res, baseUrl);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("@cg3/prior-identity", () => {
  it("exports createPriorIdentity", async () => {
    const mod = await import("../dist/index.js");
    assert.ok(typeof mod.createPriorIdentity === "function");
  });

  it("validate returns null for garbage token", async () => {
    const { createPriorIdentity } = await import("../dist/index.js");
    const identity = createPriorIdentity({ clientId: "codenotes" });
    const result = await identity.validate("not-a-jwt");
    assert.equal(result, null);
  });

  it("validate returns null for token signed with unknown key", async () => {
    const { createPriorIdentity } = await import("../dist/index.js");
    const identity = createPriorIdentity({ clientId: "codenotes" });
    const token = await createToken();
    const result = await identity.validate(token);
    assert.equal(result, null);
  });

  it("validateEnv returns null when env var not set", async () => {
    const { createPriorIdentity } = await import("../dist/index.js");
    const identity = createPriorIdentity({ clientId: "codenotes" });
    delete process.env.PRIOR_ACCESS_TOKEN;
    const result = await identity.validateEnv();
    assert.equal(result, null);
  });

  it("validateEnv reads from custom env var", async () => {
    const { createPriorIdentity } = await import("../dist/index.js");
    const identity = createPriorIdentity({
      clientId: "codenotes",
      tokenEnvVar: "MY_CUSTOM_TOKEN",
    });
    delete process.env.MY_CUSTOM_TOKEN;
    const result = await identity.validateEnv();
    assert.equal(result, null);
  });

  it("clearCache does not throw", async () => {
    const { createPriorIdentity } = await import("../dist/index.js");
    const identity = createPriorIdentity({ clientId: "codenotes" });
    identity.clearCache();
  });

  it("getEmail returns null for invalid token", async () => {
    const { createPriorIdentity } = await import("../dist/index.js");
    const identity = createPriorIdentity({ clientId: "codenotes" });
    const result = await identity.getEmail("invalid-token");
    assert.equal(result, null);
  });

  it("getUserInfo and getEmail use the discovered userinfo endpoint", async () => {
    await withLocalOidcIssuer({
      onRequest(req, res) {
        if (req.url === "/userinfo") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            sub: "account-123",
            name: "Alice",
            email: "alice@example.com",
            email_verified: true,
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      },
    }, async (issuer) => {
      const { createPriorIdentity } = await import("../dist/index.js");
      const identity = createPriorIdentity({
        clientId: "codenotes",
        issuer,
      });

      const info = await identity.getUserInfo("userinfo-token");
      assert.deepEqual(info, {
        sub: "account-123",
        name: "Alice",
        email: "alice@example.com",
        email_verified: true,
      });

      const email = await identity.getEmail("userinfo-token");
      assert.equal(email, "alice@example.com");
    });
  });
});

describe("validate with local issuer metadata", () => {
  it("derives JWKS from the configured issuer when jwksUrl is omitted", async () => {
    const kp = await jose.generateKeyPair("ES256");

    await withLocalOidcIssuer({ keyPair: kp }, async (issuer) => {
      const token = await new jose.SignJWT({
        name: "Issuer Alice",
        scope: "identity:read",
        type: "access",
      })
        .setProtectedHeader({ alg: "ES256", kid: "local-test-key" })
        .setIssuer(issuer)
        .setSubject("account-issuer")
        .setJti("jti-issuer")
        .setAudience("codenotes")
        .setExpirationTime("1h")
        .sign(kp.privateKey);

      const { createPriorIdentity } = await import("../dist/index.js");
      const identity = createPriorIdentity({ clientId: "codenotes", issuer });
      const result = await identity.validate(token);
      assert.deepEqual(result, {
        subject: "account-issuer",
        displayName: "Issuer Alice",
        audience: "codenotes",
        jti: "jti-issuer",
      });
    });
  });

  it("validates a delegated access token with identity:read scope", async () => {
    const kp = await jose.generateKeyPair("ES256");
    const token = await new jose.SignJWT({
      name: "Delegated Alice",
      scope: "identity:read",
      type: "access",
    })
      .setProtectedHeader({ alg: "ES256", kid: "local-test-key" })
      .setIssuer("https://api.cg3.io")
      .setSubject("account-456")
      .setJti("jti-delegated")
      .setAudience("codenotes")
      .setExpirationTime("1h")
      .sign(kp.privateKey);

    await withLocalOidcIssuer({ keyPair: kp }, async (issuer) => {
      const { createPriorIdentity } = await import("../dist/index.js");
      const identity = createPriorIdentity({ clientId: "codenotes", jwksUrl: `${issuer}/.well-known/jwks.json` });
      const result = await identity.validate(token);
      assert.deepEqual(result, {
        subject: "account-456",
        displayName: "Delegated Alice",
        audience: "codenotes",
        jti: "jti-delegated",
      });
    });
  });

  it("rejects delegated access token without identity:read scope", async () => {
      const kp = await jose.generateKeyPair("ES256");
      const token = await new jose.SignJWT({
        name: "Delegated Alice",
        scope: "profile",
      type: "access",
    })
      .setProtectedHeader({ alg: "ES256", kid: "local-test-key" })
      .setIssuer("https://api.cg3.io")
      .setSubject("account-456")
      .setJti("jti-delegated-missing-scope")
      .setAudience("codenotes")
      .setExpirationTime("1h")
      .sign(kp.privateKey);

    await withLocalOidcIssuer({ keyPair: kp }, async (issuer) => {
      const { createPriorIdentity } = await import("../dist/index.js");
      const identity = createPriorIdentity({ clientId: "codenotes", jwksUrl: `${issuer}/.well-known/jwks.json` });
      const result = await identity.validate(token);
      assert.equal(result, null);
    });
  });

  it("rejects delegated access tokens with the wrong issuer", async () => {
    const kp = await jose.generateKeyPair("ES256");
    const token = await new jose.SignJWT({
      name: "Wrong Issuer Alice",
      scope: "identity:read",
      type: "access",
    })
      .setProtectedHeader({ alg: "ES256", kid: "local-test-key" })
      .setIssuer("https://wrong-issuer.example.com")
      .setSubject("account-wrong-issuer")
      .setJti("jti-wrong-issuer")
      .setAudience("codenotes")
      .setExpirationTime("1h")
      .sign(kp.privateKey);

    await withLocalOidcIssuer({ keyPair: kp }, async (issuer) => {
      const { createPriorIdentity } = await import("../dist/index.js");
      const identity = createPriorIdentity({ clientId: "codenotes", issuer, jwksUrl: `${issuer}/.well-known/jwks.json` });
      const result = await identity.validate(token);
      assert.equal(result, null);
    });
  });

  it("rejects expired delegated access tokens", async () => {
    const kp = await jose.generateKeyPair("ES256");
    const token = await new jose.SignJWT({
      name: "Expired Alice",
      scope: "identity:read",
      type: "access",
    })
      .setProtectedHeader({ alg: "ES256", kid: "local-test-key" })
      .setIssuer("https://api.cg3.io")
      .setSubject("account-expired")
      .setJti("jti-expired")
      .setAudience("codenotes")
      .setExpirationTime("1 second ago")
      .sign(kp.privateKey);

    await withLocalOidcIssuer({ keyPair: kp }, async (issuer) => {
      const { createPriorIdentity } = await import("../dist/index.js");
      const identity = createPriorIdentity({ clientId: "codenotes", jwksUrl: `${issuer}/.well-known/jwks.json` });
      const result = await identity.validate(token);
      assert.equal(result, null);
    });
  });

  it("rejects tokens with unsupported type claims", async () => {
      const kp = await jose.generateKeyPair("ES256");
      const token = await new jose.SignJWT({
        name: "Unsupported Alice",
        scope: "identity:read",
      type: "identity",
    })
      .setProtectedHeader({ alg: "ES256", kid: "local-test-key" })
      .setIssuer("https://api.cg3.io")
      .setSubject("unsupported-account")
      .setJti("unsupported-jti")
      .setAudience("codenotes")
      .setExpirationTime("1h")
      .sign(kp.privateKey);

    await withLocalOidcIssuer({ keyPair: kp }, async (issuer) => {
      const { createPriorIdentity } = await import("../dist/index.js");
      const identity = createPriorIdentity({ clientId: "codenotes", jwksUrl: `${issuer}/.well-known/jwks.json` });
      const result = await identity.validate(token);
      assert.equal(result, null);
    });
  });

  it("onNewUser receives token as second argument", async () => {
    const { createPriorIdentity } = await import("../dist/index.js");
    const identity = createPriorIdentity({
      clientId: "test",
      onNewUser: async (_user, token) => {
        assert.equal(typeof token, "string");
      },
    });
    assert.ok(typeof identity.validate === "function");
  });

  it("validate rejects token with missing sub claim", async () => {
    const { createPriorIdentity } = await import("../dist/index.js");
    const identity = createPriorIdentity({ clientId: "codenotes" });
    const token = await createToken({ sub: undefined });
    const result = await identity.validate(token);
    assert.equal(result, null);
  });
});
