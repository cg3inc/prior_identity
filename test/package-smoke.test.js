import test from "node:test";
import assert from "node:assert/strict";

test("package exports root and connect subpath", async () => {
  const root = await import("@cg3/prior-identity");
  const connect = await import("@cg3/prior-identity/connect");

  assert.equal(typeof root.createPriorIdentity, "function");
  assert.equal(typeof connect.connectInteractive, "function");
});
