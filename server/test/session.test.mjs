import assert from "node:assert/strict";
import test from "node:test";

import {
  TOKEN_RENEW_WITHIN_SEC,
  TOKEN_TTL_SEC,
  needsRenewal,
  signToken,
  verifyToken,
} from "../src/auth.ts";

const secret = "test-secret";
const now = Date.UTC(2025, 0, 1);

test("a freshly issued login is not renewed", () => {
  const exp = now / 1000 + TOKEN_TTL_SEC;
  assert.equal(needsRenewal(exp, now), false);
});

test("a login in its last days is renewed while it is still in use", () => {
  const almostExpired = now / 1000 + TOKEN_RENEW_WITHIN_SEC - 1;
  assert.equal(needsRenewal(almostExpired, now), true);
  // Right on the boundary there is still enough time left to leave it alone.
  const boundary = now / 1000 + TOKEN_RENEW_WITHIN_SEC;
  assert.equal(needsRenewal(boundary, now), false);
});

test("an already expired login is renewed rather than trusted", () => {
  assert.equal(needsRenewal(now / 1000 - 60, now), true);
});

test("a token without an expiry is left untouched", () => {
  assert.equal(needsRenewal(undefined, now), false);
  assert.equal(needsRenewal(null, now), false);
  assert.equal(needsRenewal(Number.NaN, now), false);
  assert.equal(needsRenewal(Number.POSITIVE_INFINITY, now), false);
});

test("a signed login round-trips with its seven day life", () => {
  const token = signToken(
    { id: 7, username: "admin", role: "admin", version: 3 },
    secret,
  );
  const user = verifyToken(token, secret);
  assert.equal(user.id, 7);
  assert.equal(user.username, "admin");
  assert.equal(user.role, "admin");
  assert.equal(user.version, 3);
  assert.ok(Math.abs(Number(user.exp) - Number(user.iat) - TOKEN_TTL_SEC) <= 1);
});
