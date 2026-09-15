import assert from "node:assert/strict";
import test from "node:test";

/** A tiny `Storage` stand-in so the login cache can be tested outside a browser. */
function fakeStore() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

globalThis.localStorage = fakeStore();
globalThis.sessionStorage = fakeStore();

const auth = await import("../src/ui/auth.ts");
const session = await import("../src/ui/session.ts");

/** Answers `/api/me` the way the server does, and counts the calls. */
function stubMe(replies) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, token: init?.headers?.Authorization });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (!reply.ok) {
      return {
        ok: false,
        status: reply.status,
        json: async () => ({ error: reply.error }),
        headers: new Headers(),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => reply.body,
      headers: new Headers(),
    };
  };
  return calls;
}

const user = { id: 1, username: "fixture", role: "admin" };

test.beforeEach(() => {
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
  session.forgetSession();
});

test("a cached login is verified once and then reused", async () => {
  auth.setToken("tok-old");
  const calls = stubMe([{ ok: true, body: { user } }]);
  assert.deepEqual(await session.loadSession(), user);
  assert.deepEqual(await session.loadSession(), user);
  assert.equal(calls.length, 1);
  assert.deepEqual(session.currentUser(), user);
});

test("a login that was renewed while in use replaces the cached token", async () => {
  // A forgotten login ("keep me signed in" unchecked) must stay in session storage.
  auth.setToken("tok-old", false);
  stubMe([{ ok: true, body: { user, token: "tok-new" } }]);
  await session.loadSession();
  assert.equal(auth.getToken(), "tok-new");
  assert.equal(auth.tokenPersisted(), false);
  assert.equal(globalThis.localStorage.getItem("yaws_token"), null);
});

test("a rejected login is dropped so the operator can sign in again", async () => {
  auth.setToken("tok-dead");
  stubMe([{ ok: false, status: 401, error: "unauthorized" }]);
  await assert.rejects(() => session.loadSession());
  assert.equal(auth.getToken(), null);
  assert.equal(session.currentUser(), null);
});

test("only local paths are accepted as a post-login redirect", () => {
  assert.equal(session.safeNext("/app/machines/1/ssh"), "/app/machines/1/ssh");
  assert.equal(session.safeNext("/app?tab=files"), "/app?tab=files");
  // An absolute URL or a protocol-relative one would be an open redirect.
  assert.equal(session.safeNext("//evil.example/app"), null);
  assert.equal(session.safeNext("https://evil.example"), null);
  assert.equal(session.safeNext("/app\\..\\evil"), null);
  assert.equal(session.safeNext(null), null);
  assert.equal(session.safeNext(""), null);
});
