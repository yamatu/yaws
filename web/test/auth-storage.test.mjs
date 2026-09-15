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

test.beforeEach(() => {
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
  auth.clearToken();
  auth.forgetUsername();
});

test("a remembered login survives a browser restart", () => {
  auth.setToken("tok-a");
  assert.equal(auth.getToken(), "tok-a");
  assert.equal(auth.tokenPersisted(), true);
  // Simulating "browser closed": session storage is dropped, local storage is not.
  globalThis.sessionStorage.clear();
  assert.equal(auth.getToken(), "tok-a");
});

test("an unremembered login only lives in the session", () => {
  auth.setToken("tok-b", false);
  assert.equal(auth.getToken(), "tok-b");
  assert.equal(globalThis.localStorage.getItem("yaws_token"), null);
  assert.equal(globalThis.sessionStorage.getItem("yaws_token"), "tok-b");
  assert.equal(auth.tokenPersisted(), false);
  globalThis.sessionStorage.clear();
  assert.equal(auth.getToken(), null);
});

test("switching the remember flag never leaves two tokens around", () => {
  auth.setToken("tok-c");
  assert.equal(globalThis.localStorage.getItem("yaws_token"), "tok-c");
  auth.setToken("tok-d", false);
  assert.equal(globalThis.localStorage.getItem("yaws_token"), null);
  assert.equal(auth.getToken(), "tok-d");
  auth.setToken("tok-e", true);
  assert.equal(globalThis.sessionStorage.getItem("yaws_token"), null);
  assert.equal(auth.getToken(), "tok-e");
});

test("clearing the login clears both stores", () => {
  auth.setToken("tok-f");
  globalThis.sessionStorage.setItem("yaws_token", "stale");
  auth.clearToken();
  assert.equal(auth.getToken(), null);
  assert.equal(globalThis.localStorage.getItem("yaws_token"), null);
  assert.equal(globalThis.sessionStorage.getItem("yaws_token"), null);
});

test("the username is remembered to pre-fill the form", () => {
  assert.equal(auth.rememberedUsername(), "");
  auth.rememberUsername("  admin  ");
  assert.equal(auth.rememberedUsername(), "admin");
  auth.rememberUsername("ops", false);
  assert.equal(auth.rememberedUsername(), "ops");
  assert.equal(globalThis.localStorage.getItem("yaws.login.user"), null);
  // A blank username must not wipe the remembered one.
  auth.rememberUsername("   ");
  assert.equal(auth.rememberedUsername(), "ops");
  auth.forgetUsername();
  assert.equal(auth.rememberedUsername(), "");
  assert.equal(globalThis.sessionStorage.getItem("yaws.login.user"), null);
});

test("unavailable storage degrades instead of throwing", () => {
  const broken = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
    removeItem() {
      throw new Error("denied");
    },
  };
  const real = globalThis.localStorage;
  const realSession = globalThis.sessionStorage;
  globalThis.localStorage = broken;
  globalThis.sessionStorage = broken;
  try {
    auth.setToken("tok-g");
    auth.rememberUsername("admin");
    assert.equal(auth.getToken(), null);
    assert.equal(auth.rememberedUsername(), "");
    assert.equal(auth.tokenPersisted(), false);
    auth.clearToken();
  } finally {
    globalThis.localStorage = real;
    globalThis.sessionStorage = realSession;
  }
});
