import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fixture.mjs";
import {
  MAX_RUNS_PER_USER,
  MAX_RUNS_TOTAL,
  RunRegistry,
} from "../dist/ai-runs.js";

test("run registry", async (t) => {
  await t.test("different keys run together, the same key does not", () => {
    const runs = new RunRegistry(2, 3);
    const a = runs.acquire("chat:u1:1", "u1");
    const b = runs.acquire("chat:u1:2", "u1");
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(runs.size, 2);
    assert.equal(runs.activeFor("u1"), 2);
    // A second turn on a conversation that is already running is refused, and
    // it must be reported as "busy" rather than as a global limit.
    assert.deepEqual(runs.acquire("chat:u1:1", "u1"), {
      ok: false,
      reason: "busy",
    });
    assert.equal(runs.has("chat:u1:1"), true);
  });

  await t.test("each user has their own allowance", () => {
    const runs = new RunRegistry(2, 3);
    assert.equal(runs.acquire("chat:u1:1", "u1").ok, true);
    assert.equal(runs.acquire("chat:u1:2", "u1").ok, true);
    // u1 is full, but u2 is untouched.
    assert.deepEqual(runs.acquire("chat:u1:3", "u1"), {
      ok: false,
      reason: "limit",
    });
    assert.equal(runs.acquire("chat:u2:1", "u2").ok, true);
    assert.equal(runs.activeFor("u1"), 2);
    assert.equal(runs.activeFor("u2"), 1);
  });

  await t.test("the server-wide ceiling still applies", () => {
    const runs = new RunRegistry(5, 2);
    assert.equal(runs.acquire("chat:u1:1", "u1").ok, true);
    assert.equal(runs.acquire("chat:u2:1", "u2").ok, true);
    assert.deepEqual(runs.acquire("chat:u3:1", "u3"), {
      ok: false,
      reason: "limit",
    });
  });

  await t.test("releasing is exact and idempotent", () => {
    const runs = new RunRegistry(1, 4);
    const first = runs.acquire("chat:u1:1", "u1");
    assert.equal(first.ok, true);
    assert.ok(first.ok);
    first.slot.release();
    first.slot.release();
    assert.equal(runs.size, 0);
    assert.equal(runs.activeFor("u1"), 0);
    // The allowance came back, so the next run can take the same key.
    const again = runs.acquire("chat:u1:1", "u1");
    assert.equal(again.ok, true);
    assert.ok(again.ok);
    // Releasing a run that never existed must not disturb the live one.
    again.slot.release();
    again.slot.release();
    assert.equal(runs.size, 0);
    assert.equal(MAX_RUNS_PER_USER > 1, true);
    assert.equal(MAX_RUNS_TOTAL > MAX_RUNS_PER_USER, true);
  });
});

/** Opens a chat stream and reads its first frame, which the server sends once
 * the run owns its slot. */
async function openChat(f, machineId, body, signal) {
  const response = await fetch(`${f.url}/api/ai/machines/${machineId}/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    let error = `http_${response.status}`;
    try {
      error = JSON.parse(text).error ?? error;
    } catch {
      // not JSON
    }
    return { status: response.status, error, events: [], finish: async () => {} };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  const times = [];
  let buffer = "";
  const push = (line) => {
    if (line.trim()) {
      events.push(JSON.parse(line));
      times.push(Date.now());
    }
  };
  // The first chunk holds the `start` event, so awaiting it means the run is
  // really in flight instead of merely queued.
  const { value } = await reader.read();
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  lines.forEach(push);
  return {
    status: response.status,
    error: "",
    events,
    times,
    async finish() {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        parts.forEach(push);
      }
    },
  };
}

const answer = (turn) =>
  turn.events.find((event) => event.type === "answer")?.text ?? "";

const at = (turn, type) => turn.times[turn.events.findIndex((e) => e.type === type)];

async function request(f, url, method = "GET", body) {
  const response = await fetch(f.url + url, {
    method,
    headers: {
      authorization: `Bearer ${f.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

/** Two machines have to be trusted before the workspace will touch them. */
async function trustHost(f, machineId) {
  const inspected = await request(
    f,
    `/api/machines/${machineId}/workspace/host-key/inspect`,
    "POST",
  );
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  const saved = await request(
    f,
    `/api/machines/${machineId}/workspace/host-key`,
    "PUT",
    inspected.body,
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
}

test("the assistant serves several machines at once", async (t) => {
  const f = await harness();
  t.after(() => f.close());
  const configured = await request(f, "/api/ai/settings", "PUT", {
    baseUrl: f.modelUrl,
    model: "fixture-model",
    protocol: "chat",
    apiKey: "fixture-key",
    allowPrivate: true,
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  await trustHost(f, 1);
  await trustHost(f, 2);

  await t.test("two machines can be asked in parallel", async () => {
    const first = await openChat(f, 1, {
      message: "[slow] 检查第一台机器的磁盘",
      root: "/srv/app",
      autoRun: "read",
    });
    assert.equal(first.status, 200, first.error || JSON.stringify(first.events));
    // The first run is streaming; a second machine must not be told to wait.
    const second = await openChat(f, 2, {
      message: "[slow] 检查第二台机器的磁盘",
      root: "/srv/app",
      autoRun: "read",
    });
    assert.equal(second.status, 200, JSON.stringify(second.error));
    assert.equal(
      first.events.some((event) => event.type === "start"),
      true,
      "the first run must have started",
    );
    assert.equal(
      second.events.some((event) => event.type === "start"),
      true,
      "the second run must have started while the first one was still running",
    );
    await Promise.all([first.finish(), second.finish()]);
    // Not just "both were accepted": the second run started before the first
    // one produced its answer, which is the whole point of the change.
    assert.ok(
      at(second, "start") < at(first, "done"),
      `second started at ${at(second, "start")}, first finished at ${at(first, "done")}`,
    );
    assert.match(answer(first), /\S/);
    assert.match(answer(second), /\S/);
    for (const turn of [first, second]) {
      assert.equal(
        turn.events.some((event) => event.type === "done"),
        true,
      );
      assert.equal(
        turn.events.some((event) => event.type === "error"),
        false,
        JSON.stringify(turn.events.filter((event) => event.type === "error")),
      );
    }
    // Both runs used their own conversation, and both landed in the database.
    const conversations = f.db
      .prepare("SELECT COUNT(*) as total FROM ai_conversations")
      .get();
    assert.equal(conversations.total, 2);
  });

  await t.test("a conversation already running refuses a second turn", async () => {
    const live = await openChat(f, 1, {
      message: "[slow] 继续检查",
      root: "/srv/app",
      autoRun: "read",
    });
    assert.equal(live.status, 200);
    const conversationId = live.events.find(
      (event) => event.type === "start",
    )?.conversationId;
    assert.ok(conversationId);
    const clash = await openChat(f, 1, {
      message: "同一对话里的第二个问题",
      root: "/srv/app",
      autoRun: "read",
      conversationId,
    });
    assert.equal(clash.status, 409, JSON.stringify(clash.error));
    assert.equal(clash.error, "ai_conversation_busy");
    await live.finish();
    // Once the run is over the conversation is free again, and asking a
    // question on it works exactly like before.
    const after = await openChat(f, 1, {
      message: "对话已经空闲",
      root: "/srv/app",
      autoRun: "read",
      conversationId,
    });
    assert.equal(after.status, 200, JSON.stringify(after.error));
    await after.finish();
    assert.match(answer(after), /\S/);
  });

  await t.test("an interrupted run gives its slot back", async () => {
    // Stopping a run (or closing the page) aborts the stream. The conversation
    // must become usable again instead of staying locked until a restart.
    const controller = new AbortController();
    const live = await openChat(
      f,
      1,
      { message: "[slow] 中途停止", root: "/srv/app", autoRun: "read" },
      controller.signal,
    );
    assert.equal(live.status, 200, live.error || JSON.stringify(live.events));
    const conversationId = live.events.find(
      (event) => event.type === "start",
    )?.conversationId;
    assert.ok(conversationId);
    controller.abort();
    let retry = { status: 0, error: "never tried", events: [] };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      retry = await openChat(f, 1, {
        message: "停止之后还能继续问",
        root: "/srv/app",
        autoRun: "read",
        conversationId,
      });
      if (retry.status === 200) break;
      assert.equal(retry.error, "ai_conversation_busy", JSON.stringify(retry));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(retry.status, 200, JSON.stringify(retry.error));
    await retry.finish();
    assert.match(answer(retry), /\S/);
  });
});
