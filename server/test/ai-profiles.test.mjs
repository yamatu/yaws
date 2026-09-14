import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { encryptText } from "../src/crypto.js";
import {
  AIProfileSchema,
  MAX_PROFILES,
  activeProfileId,
  endpointError,
  mergeProfileKeys,
  pickProfile,
  publicProfiles,
  readProfiles,
  writeProfiles,
} from "../src/ai-profiles.js";

const secret = "s".repeat(32);
const profile = (over = {}) => ({
  id: "one",
  name: "一个配置",
  baseUrl: "https://api.example.com/v1",
  protocol: "chat",
  model: "flash",
  reasoning: "",
  apiKey: "sk-one",
  allowPrivate: false,
  ...over,
});

test("ai profiles", async (t) => {
  await t.test("rejects endpoints that can smuggle credentials", () => {
    assert.equal(endpointError("https://api.example.com/v1"), null);
    assert.equal(endpointError("http://127.0.0.1:8080/v1"), null);
    assert.equal(
      endpointError("https://user:pass@api.example.com/v1"),
      "bad_ai_endpoint",
    );
    assert.equal(
      endpointError("https://api.example.com/v1?key=secret"),
      "bad_ai_endpoint",
    );
    assert.equal(
      endpointError("https://api.example.com/v1#frag"),
      "bad_ai_endpoint",
    );
    assert.equal(endpointError("ftp://api.example.com/v1"), "bad_ai_endpoint");
    assert.equal(endpointError("not a url"), "bad_ai_endpoint");
  });

  await t.test("profile names and ids are constrained", () => {
    assert.equal(AIProfileSchema.safeParse(profile()).success, true);
    assert.equal(
      AIProfileSchema.safeParse(profile({ id: "has space" })).success,
      false,
    );
    assert.equal(
      AIProfileSchema.safeParse(profile({ id: "" })).success,
      false,
    );
    assert.equal(
      AIProfileSchema.safeParse(profile({ name: "   " })).success,
      false,
    );
    assert.equal(
      AIProfileSchema.safeParse(profile({ model: "" })).success,
      false,
    );
    assert.equal(
      AIProfileSchema.safeParse(profile({ baseUrl: "api.example.com" }))
        .success,
      false,
    );
  });

  await t.test("the requested profile wins, then the active one", () => {
    const list = [
      profile({ id: "a", name: "A" }),
      profile({ id: "b", name: "B" }),
    ];
    assert.equal(pickProfile(list, "b", "a")?.name, "A");
    assert.equal(pickProfile(list, "b")?.name, "B");
    assert.equal(pickProfile(list, "missing")?.name, "A");
    assert.equal(pickProfile(list, "b", "missing")?.name, "B");
    assert.equal(pickProfile([], "b"), undefined);
  });

  await t.test("editing keeps stored keys unless one is sent", () => {
    const previous = [profile({ id: "a" }), profile({ id: "b", apiKey: "sk-b" })];
    const merged = mergeProfileKeys(
      [
        { ...profile({ id: "a" }), apiKey: "" },
        { ...profile({ id: "b" }), apiKey: "sk-new" },
        { ...profile({ id: "c" }), apiKey: "sk-c" },
      ],
      previous,
    );
    assert.equal(merged[0].apiKey, "sk-one");
    assert.equal(merged[1].apiKey, "sk-new");
    assert.equal(merged[2].apiKey, "sk-c");
    const cleared = mergeProfileKeys(
      [{ ...profile({ id: "a" }), apiKey: null }],
      previous,
    );
    assert.equal(cleared[0].apiKey, "");
  });

  await t.test("public profiles never leak keys", () => {
    const list = [profile({ id: "a" }), profile({ id: "b", name: "B" })];
    const view = publicProfiles(list, "b");
    assert.equal(view.activeId, "b");
    assert.equal(view.profiles[0].hasKey, true);
    assert.equal("apiKey" in view.profiles[0], false);
    assert.equal(publicProfiles(list, "gone").activeId, "a");
    assert.equal(publicProfiles([], "gone").activeId, "");
  });

  await t.test("stored profiles round trip and follow the active one", () => {
    const db = openDb(":memory:");
    try {
      assert.deepEqual(readProfiles(db, secret), []);
      writeProfiles(
        db,
        secret,
        [profile({ id: "a", name: "A" }), profile({ id: "b", name: "B" })],
        "b",
      );
      assert.deepEqual(
        readProfiles(db, secret).map((p) => p.name),
        ["A", "B"],
      );
      assert.equal(activeProfileId(db), "b");
      // An unknown active id falls back to the first profile instead of erroring.
      writeProfiles(db, secret, readProfiles(db, secret), "gone");
      assert.equal(activeProfileId(db), "a");
      // Deleting every profile stays empty; the legacy config must not come back.
      writeProfiles(db, secret, [], "a");
      assert.deepEqual(readProfiles(db, secret), []);
    } finally {
      db.close();
    }
  });

  await t.test("a legacy single config becomes one default profile", () => {
    const db = openDb(":memory:");
    try {
      db.prepare(
        "INSERT INTO settings (key,value,updated_at) VALUES ('ai_config_enc',?,0)",
      ).run(
        encryptText(
          JSON.stringify({
            baseUrl: "https://legacy.example.com/v1",
            model: "legacy-model",
            protocol: "responses",
            reasoning: "high",
            apiKey: "sk-legacy",
            allowPrivate: true,
          }),
          secret,
        ),
      );
      const migrated = readProfiles(db, secret);
      assert.equal(migrated.length, 1);
      assert.equal(migrated[0].id, "default");
      assert.equal(migrated[0].name, "默认配置");
      assert.equal(migrated[0].model, "legacy-model");
      assert.equal(migrated[0].protocol, "responses");
      assert.equal(migrated[0].apiKey, "sk-legacy");
      // Once written back the legacy row is no longer consulted.
      writeProfiles(db, secret, [profile({ id: "fresh", name: "新配置" })], "fresh");
      assert.deepEqual(
        readProfiles(db, secret).map((p) => p.id),
        ["fresh"],
      );
    } finally {
      db.close();
    }
  });

  await t.test("a corrupt profile blob falls back to the legacy config", () => {
    const db = openDb(":memory:");
    try {
      db.prepare(
        "INSERT INTO settings (key,value,updated_at) VALUES ('ai_config_enc',?,0)",
      ).run(
        encryptText(
          JSON.stringify({
            baseUrl: "https://legacy.example.com/v1",
            model: "legacy-model",
          }),
          secret,
        ),
      );
      db.prepare(
        "INSERT INTO settings (key,value,updated_at) VALUES ('ai_profiles_enc',?,0)",
      ).run(encryptText("not json at all", secret));
      assert.equal(readProfiles(db, secret).length, 1);
      assert.equal(readProfiles(db, secret)[0].id, "default");
    } finally {
      db.close();
    }
  });

  await t.test("the profile list is bounded", () => {
    const db = openDb(":memory:");
    try {
      const many = Array.from({ length: MAX_PROFILES }, (_, i) =>
        profile({ id: `p${i}`, name: `配置 ${i}` }),
      );
      writeProfiles(db, secret, many, "p1");
      assert.equal(readProfiles(db, secret).length, MAX_PROFILES);
      writeProfiles(db, secret, [...many, profile({ id: "extra" })], "p1");
      // Too many rows are ignored rather than trusted, so the workspace reports
      // "not configured" instead of serving a truncated list.
      assert.deepEqual(readProfiles(db, secret), []);
    } finally {
      db.close();
    }
  });
});
