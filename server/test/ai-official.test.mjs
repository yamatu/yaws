import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { harness } from "./fixture.mjs";
import { hashPassword, signToken } from "../dist/auth.js";
import {
  OfficialModels, OfficialCredentials, officialCatalog, toContext,
} from "../dist/ai-official.js";

const original = builtinProviders().find((item) => item.id === "openai-codex");
const catalog = officialCatalog().find((item) => item.id === "openai-codex");
const modelId = catalog.models[0].id;
function fakeProvider(seen = [], callTool = false) {
  return {
    ...original,
    auth: {
      oauth: {
        name: "Fake local authorization",
        async login(interaction) {
          interaction.notify({ type: "auth_url", url: "https://auth.openai.com/authorize" });
          const value = await interaction.prompt({
            type: "manual_code", message: "Paste authorization code",
          });
          if (value !== "code-ok") throw new Error(`do not leak ${value}`);
          return { type: "oauth", access: "local-secret-access",
            refresh: "local-secret-refresh", expires: Date.now() + 3600_000 };
        },
        async refresh(credential) { return credential; },
        async toAuth(credential) { return { apiKey: credential.access }; },
      },
    },
    streamSimple(model, context) {
      seen.push(context);
      const stream = createAssistantMessageEventStream();
      const needsTool = callTool && !context.messages.some(
        (entry) => entry.role === "toolResult",
      );
      const message = {
        role: "assistant", api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(),
        stopReason: needsTool ? "toolUse" : "stop",
        content: needsTool ? [
          { type: "thinking", thinking: "private reasoning",
            thinkingSignature: "signed-replay" },
          { type: "toolCall", id: "native_tool_1",
            name: "run_command", arguments: { command: "df -h /" } },
        ] : [{ type: "text", text: "来自官方模型的测试回答" }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
          totalTokens: 15, cost: { input: 0, output: 0,
            cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (needsTool) stream.push({ type: "toolcall_start", contentIndex: 1,
          partial: message });
        else stream.push({ type: "text_delta", delta: "来自官方模型的测试回答",
          contentIndex: 0, partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  };
}

const auth = (token) => ({
  authorization: `Bearer ${token}`, "content-type": "application/json",
});
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("pi official login and native model work through authenticated routes", async () => {
  const seen = [];
  let service;
  const f = await harness(0, (db, secret) => {
    service = new OfficialModels(db, secret, [fakeProvider(seen, true)]);
    return service;
  });
  try {
    const options = await fetch(`${f.url}/api/ai/official/providers`,
      { headers: auth(f.token) });
    const providers = (await options.json()).providers;
    assert.ok(providers.some((item) => item.id === "openai-codex"));
    assert.equal(providers.find((item) => item.id === "openai-codex").connected, false);
    assert.equal((await fetch(`${f.url}/api/ai/official/providers`,
      { headers: auth(f.viewerToken) })).status, 403);

    const start = await fetch(`${f.url}/api/ai/official/login`, {
      method: "POST", headers: auth(f.token),
      body: JSON.stringify({ provider: "openai-codex" }),
    });
    assert.equal(start.status, 200);
    const { loginId } = await start.json();
    assert.equal((await fetch(`${f.url}/api/ai/official/login/${loginId}`,
      { headers: auth(f.viewerToken) })).status, 403);
    f.db.prepare(`INSERT INTO users(id,username,password_hash,role,created_at)
      VALUES (4,'other-admin',?,'admin',0)`)
      .run(await hashPassword("other-admin-test-only"));
    const other = signToken({ id: 4, username: "other-admin",
      role: "admin", version: 0 }, f.secret);
    assert.equal((await fetch(`${f.url}/api/ai/official/login/${loginId}`,
      { headers: auth(other) })).status, 404);
    assert.equal((await fetch(`${f.url}/api/ai/official/login/${loginId}/answer`, {
      method: "POST", headers: auth(other),
      body: JSON.stringify({ value: "code-ok" }),
    })).status, 404);
    assert.equal((await fetch(`${f.url}/api/ai/official/login`, {
      method: "POST", headers: auth(f.token),
      body: JSON.stringify({ provider: "openai-codex" }),
    })).status, 409);
    let status;
    for (let i = 0; i < 30; i++) {
      status = await (await fetch(`${f.url}/api/ai/official/login/${loginId}`,
        { headers: auth(f.token) })).json();
      if (status.event?.type === "prompt") break;
      await wait();
    }
    assert.equal(status.event?.type, "prompt");
    assert.equal(status.authEvent.url, "https://auth.openai.com/authorize");
    assert.equal((await fetch(`${f.url}/api/ai/official/login/${loginId}/answer`, {
      method: "POST", headers: auth(f.token),
      body: JSON.stringify({ value: "code-ok" }),
    })).status, 200);
    for (let i = 0; i < 30; i++) {
      status = await (await fetch(`${f.url}/api/ai/official/login/${loginId}`,
        { headers: auth(f.token) })).json();
      if (status.status === "done") break;
      await wait();
    }
    assert.equal(status.status, "done");
    assert.equal(status.authEvent, null);
    const body = await (await fetch(`${f.url}/api/ai/official/providers`,
      { headers: auth(f.token) })).text();
    assert.ok(body.includes('"connected":true'));
    assert.ok(!body.includes("local-secret"));
    const stored = f.db.prepare("SELECT value FROM settings WHERE key='ai_official_auth_openai-codex'").get();
    assert.ok(stored);
    assert.ok(!stored.value.includes("local-secret"));

    const profile = {
      id: "native", name: "官方 Codex", officialProvider: "openai-codex",
      baseUrl: catalog.baseUrl, model: modelId, protocol: "chat",
      reasoning: "", apiKey: "", allowPrivate: false,
    };
    const saved = await fetch(`${f.url}/api/ai/profiles`, {
      method: "PUT", headers: auth(f.token),
      body: JSON.stringify({ activeId: "native", profiles: [profile] }),
    });
    assert.equal(saved.status, 200, await saved.text());
    const publicList = await (await fetch(`${f.url}/api/ai/profiles`,
      { headers: auth(f.token) })).text();
    assert.ok(!publicList.includes("local-secret"));
    const chat = await fetch(`${f.url}/api/ai/machines/1/chat`, {
      method: "POST", headers: auth(f.token),
      body: JSON.stringify({ root: "/srv/app", message: "你好", profileId: "native" }),
    });
    const reply = await chat.text();
    assert.equal(chat.status, 200, reply);
    assert.match(reply, /来自官方模型的测试回答/);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].messages.at(-1).content, "你好");
    // pi >=0.86 normalizes Context into a transcript: the prompt and tools
    // arrive as a leading system message instead of `systemPrompt`/`tools`.
    assert.equal(seen[0].messages[0].role, "system");
    assert.ok(seen[0].messages[0].content.length > 0);
    assert.ok(seen[0].messages[0].toolsAdded.length > 0);
    assert.equal(seen[1].messages.at(-1).role, "toolResult");
    assert.equal(seen[1].messages.at(-1).toolName, "run_command");
    assert.equal(seen[1].messages.at(-2).content[0].thinkingSignature,
      "signed-replay");
    assert.match(reply, /df -h/);

    const logout = await fetch(`${f.url}/api/ai/official/providers/openai-codex`, {
      method: "DELETE", headers: auth(f.token),
    });
    assert.equal(logout.status, 200, await logout.text());
    assert.equal(await service.credentials.read("openai-codex"), undefined);
    const afterLogout = await fetch(`${f.url}/api/ai/machines/1/chat`, {
      method: "POST", headers: auth(f.token),
      body: JSON.stringify({ root: "/srv/app", message: "再试一次",
        profileId: "native" }),
    });
    assert.match(await afterLogout.text(), /official_not_logged_in/);
    assert.equal(seen.length, 2, "no native request without login");
  } finally { await f.close(); }
});

test("official endpoints/models cannot be substituted or leaked", async () => {
  const f = await harness();
  try {
    const profile = {
      id: "bad", name: "伪装", officialProvider: "openai-codex",
      baseUrl: "https://attacker.example/v1", model: modelId,
      protocol: "chat", reasoning: "", apiKey: "", allowPrivate: false,
    };
    for (const changes of [{}, { baseUrl: catalog.baseUrl,
      apiKey: "please-send-this-to-the-provider" },
    { baseUrl: catalog.baseUrl, apiKey: "", model: "hallucinated" },
    { baseUrl: catalog.baseUrl, model: modelId, allowPrivate: true }]) {
      const response = await fetch(`${f.url}/api/ai/profiles`, {
        method: "PUT", headers: auth(f.token),
        body: JSON.stringify({ activeId: "bad", profiles: [{ ...profile, ...changes }] }),
      });
      assert.equal(response.status, 400, JSON.stringify(changes));
    }
    assert.equal((await fetch(`${f.url}/api/ai/official/login`, {
      method: "POST", headers: auth(f.token),
      body: JSON.stringify({ provider: "arbitrary" }),
    })).status, 400);
  } finally { await f.close(); }
});

test("cancelled authorization cannot save credentials", async () => {
  let service;
  const f = await harness(0, (db, secret) => {
    service = new OfficialModels(db, secret, [fakeProvider()]);
    return service;
  });
  try {
    const start = await fetch(`${f.url}/api/ai/official/login`, {
      method: "POST", headers: auth(f.token),
      body: JSON.stringify({ provider: "openai-codex" }),
    });
    const { loginId } = await start.json();
    const cancelled = await fetch(`${f.url}/api/ai/official/login/${loginId}`, {
      method: "DELETE", headers: auth(f.token),
    });
    assert.equal(cancelled.status, 200);
    await wait(50);
    assert.equal((await service.credentials.read("openai-codex")), undefined);
    const status = await (await fetch(`${f.url}/api/ai/official/login/${loginId}`,
      { headers: auth(f.token) })).json();
    assert.equal(status.status, "cancelled");
    assert.equal((await fetch(`${f.url}/api/ai/official/login/${loginId}/answer`, {
      method: "POST", headers: auth(f.token),
      body: JSON.stringify({ value: "code-ok" }),
    })).status, 409);
  } finally { await f.close(); }
});

test("a provider cannot make the UI display a lookalike login host", async () => {
  const f = await harness();
  try {
    const base = fakeProvider();
    const provider = { ...base, auth: { oauth: { ...base.auth.oauth,
      async login(interaction) {
        interaction.notify({ type: "auth_url",
          url: "https://auth.openai.com.attacker.test/login" });
        return { type: "oauth", access: "stolen", refresh: "secret",
          expires: Date.now() + 3600_000 };
      },
    } } };
    const service = new OfficialModels(f.db, f.secret, [provider]);
    const { loginId } = service.start("openai-codex", 1);
    await wait(40);
    const status = service.status(loginId, 1);
    assert.equal(status.status, "failed");
    assert.equal(status.authEvent, null);
    assert.equal(await service.credentials.read("openai-codex"), undefined);
  } finally { await f.close(); }
});

test("encrypted credentials serialize concurrent refreshes and deletions", async () => {
  const f = await harness();
  try {
    const store = new OfficialCredentials(f.db, f.secret);
    let inFlight = 0, peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => store.modify(
      "anthropic", async (current) => {
        peak = Math.max(peak, ++inFlight);
        await wait(5);
        --inFlight;
        return { type: "oauth", access: `access-${Number(current?.access?.split("-")[1] ?? 0) + 1}`,
          refresh: "refresh", expires: Date.now() + 10000 };
      },
    )));
    assert.equal(peak, 1);
    assert.equal((await store.read("anthropic")).access, "access-6");
    assert.ok(!f.db.prepare("SELECT value FROM settings WHERE key='ai_official_auth_anthropic'")
      .get().value.includes("access-6"));
    await store.delete("anthropic");
    assert.equal(await store.read("anthropic"), undefined);
  } finally { await f.close(); }
});

test("expired official tokens are refreshed and encrypted before streaming", async () => {
  const f = await harness();
  try {
    const provider = fakeProvider();
    let refreshed = 0;
    const refreshable = { ...provider, auth: { oauth: {
      ...provider.auth.oauth,
      async refresh(credential) {
        refreshed++;
        return { ...credential, access: "rotated-local-secret",
          refresh: "rotated-refresh-secret", expires: Date.now() + 3600_000 };
      },
    } } };
    const service = new OfficialModels(f.db, f.secret, [refreshable]);
    await service.credentials.modify("openai-codex", async () => ({
      type: "oauth", access: "expired-secret", refresh: "old-secret",
      expires: Date.now() - 1000,
    }));
    const config = { officialProvider: "openai-codex",
      baseUrl: catalog.baseUrl, model: modelId, apiKey: "", protocol: "chat",
      reasoning: "", allowPrivate: false };
    const deltas = [];
    const turn = await service.stream(config, { messages: [
      { role: "system", content: "help" },
      { role: "user", content: "hello" },
    ], tools: [] }, new AbortController().signal, (event) => deltas.push(event));
    assert.equal(refreshed, 1);
    assert.equal((await service.credentials.read("openai-codex")).access,
      "rotated-local-secret");
    assert.match(turn.content, /测试回答/);
    assert.equal(deltas.find((event) => event.type === "usage")
      .usage.cachedTokens, null);
    const cipher = f.db.prepare("SELECT value FROM settings WHERE key='ai_official_auth_openai-codex'").get().value;
    assert.ok(!cipher.includes("rotated-local-secret"));
  } finally { await f.close(); }
});

test("provider-neutral history keeps assistant calls paired with tool results", () => {
  const model = original.getModels()[0];
  const context = toContext({ messages: [
    { role: "system", content: "Only inspect" },
    { role: "user", content: "disk?" },
    { role: "assistant", content: "checking", tool_calls: [{ id: "call_1",
      function: { name: "run_command", arguments: '{"command":"df -h"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "50%" },
  ], tools: [{ function: { name: "run_command", description: "Run",
    parameters: { type: "object", properties: { command: { type: "string" } } } } }] }, model);
  assert.equal(context.systemPrompt, "Only inspect");
  assert.equal(context.messages[1].content[1].name, "run_command");
  assert.equal(context.messages[2].toolName, "run_command");
  assert.equal(context.messages[2].content[0].text, "50%");
  assert.equal(context.tools[0].name, "run_command");
});
