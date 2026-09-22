import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fixture.mjs";
import { runGuard, MAX_CONTINUATIONS } from "../dist/ai-chat.js";

/** Chat replies arrive as newline delimited JSON. */
async function chat(f, body, token = f.token) {
  const response = await fetch(`${f.url}/api/ai/machines/1/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    events: text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    body: text,
  };
}

/**
 * Streams a chat request and aborts the connection once the accumulated NDJSON
 * matches, imitating a page switch that drops the stream mid-run. Returns the
 * bytes received before the abort.
 */
async function chatUntil(f, body, match) {
  const ac = new AbortController();
  const response = await fetch(`${f.url}/api/ai/machines/1/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: ac.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (match(text)) {
        ac.abort();
        break;
      }
    }
  } catch {
    // aborted on purpose
  }
  return text;
}

/** Every tool card appears twice (running, then the result); keep the last state. */
function toolsOf(turn) {
  const latest = new Map();
  for (const event of turn.events)
    if (event.type === "tool") latest.set(event.tool.id, event.tool);
  return [...latest.values()];
}

const settings = (f) => ({
  baseUrl: f.modelUrl,
  model: "fixture-model",
  protocol: "chat",
  apiKey: "fixture-key",
  allowPrivate: true,
});

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
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

const proposals = (f) =>
  f.db.prepare("SELECT id,status,kind FROM ai_proposals").all();

test("ai chat", async (t) => {
  const f = await harness();
  t.after(() => f.close());
  assert.equal(
    (await request(f, "/api/ai/settings", "PUT", settings(f))).status,
    200,
  );
  // The workspace refuses to touch a host with an unverified host key.
  const inspected = await request(f, "/api/machines/1/workspace/host-key/inspect", "POST");
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  assert.equal(
    (await request(f, "/api/machines/1/workspace/host-key", "PUT", inspected.body)).status,
    200,
  );

  await t.test("several profiles can be stored and switched", async () => {
    const single = await request(f, "/api/ai/profiles");
    assert.equal(single.status, 200);
    assert.equal(single.body.profiles.length, 1);
    assert.equal(single.body.profiles[0].name, "默认配置");
    assert.equal(single.body.profiles[0].model, "fixture-model");
    assert.equal(single.body.profiles[0].hasKey, true);
    assert.equal("apiKey" in single.body.profiles[0], false);
    assert.equal(single.body.activeId, "default");

    const both = await request(f, "/api/ai/profiles", "PUT", {
      activeId: "fast",
      profiles: [
        {
          id: "fast",
          name: "快速模型",
          baseUrl: f.modelUrl,
          model: "fixture-model",
          protocol: "chat",
          reasoning: "low",
          apiKey: "fast-key",
          allowPrivate: true,
        },
        {
          id: "smart",
          name: "强推理模型",
          baseUrl: f.modelUrl,
          model: "fixture-model",
          protocol: "chat",
          reasoning: "high",
          apiKey: "smart-key",
          allowPrivate: true,
        },
      ],
    });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.deepEqual(
      both.body.profiles.map((p) => p.name),
      ["快速模型", "强推理模型"],
    );
    assert.equal(both.body.activeId, "fast");

    const turn = await chat(f, {
      root: "/srv/app",
      message: "[run] 用哪个模型",
      autoRun: "read",
      profileId: "smart",
    });
    const start = turn.events.find((e) => e.type === "start");
    assert.equal(start.profile.name, "强推理模型");
    assert.equal(
      f.modelRequests.at(-1).headers.authorization,
      "Bearer smart-key",
      "the selected profile owns the API key",
    );
    const list = await request(f, "/api/ai/conversations?machineId=1");
    const row = list.body.conversations.find(
      (c) => c.id === start.conversationId,
    );
    assert.equal(row.model, "fixture-model");
    assert.equal(row.preview, "[run] 用哪个模型");
    assert.equal(row.lastStatus, "completed");

    // Renaming keeps the row but changes what the picker shows.
    assert.equal(
      (await request(f, `/api/ai/conversations/${start.conversationId}`, "PATCH", {
        title: "排查磁盘",
      })).status,
      200,
    );
    const renamed = await request(f, "/api/ai/conversations?machineId=1");
    assert.equal(
      renamed.body.conversations.find((c) => c.id === start.conversationId)
        .title,
      "排查磁盘",
    );
    assert.equal(
      (await request(f, "/api/ai/conversations/missing", "PATCH", {
        title: "x",
      })).status,
      404,
    );

    // Switching the active profile is what the UI does on selection.
    assert.equal(
      (await request(f, "/api/ai/profiles/active", "PUT", { id: "smart" }))
        .status,
      200,
    );
    const active = await request(f, "/api/ai/profiles");
    assert.equal(active.body.activeId, "smart");
    assert.equal(
      (await request(f, "/api/ai/profiles/active", "PUT", { id: "nope" }))
        .status,
      404,
    );
    // Config validation happens before anything is stored.
    assert.equal(
      (await request(f, "/api/ai/profiles", "PUT", {
        activeId: "fast",
        profiles: [
          {
            id: "fast",
            name: "坏地址",
            baseUrl: "https://user:pass@example.com/v1",
            model: "fixture-model",
          },
        ],
      })).status,
      400,
    );
    assert.equal(
      (await request(f, "/api/ai/profiles", "PUT", {
        activeId: "fast",
        profiles: [
          { id: "same", name: "A", baseUrl: f.modelUrl, model: "m" },
          { id: "same", name: "B", baseUrl: f.modelUrl, model: "m" },
        ],
      })).status,
      400,
    );
    // Editing without a key keeps the stored one.
    const edited = await request(f, "/api/ai/profiles", "PUT", {
      activeId: "smart",
      profiles: [
        {
          id: "fast",
          name: "快速模型 v2",
          baseUrl: f.modelUrl,
          model: "fixture-model",
          reasoning: "medium",
          allowPrivate: true,
        },
        {
          id: "smart",
          name: "强推理模型",
          baseUrl: f.modelUrl,
          model: "fixture-model",
          reasoning: "high",
          allowPrivate: true,
        },
      ],
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.profiles[0].hasKey, true);
    const again = await chat(f, {
      root: "/srv/app",
      message: "[run] 再次提问",
      autoRun: "read",
      profileId: "fast",
    });
    assert.equal(
      again.events.find((e) => e.type === "start").profile.name,
      "快速模型 v2",
    );
    assert.equal(
      f.modelRequests.at(-1).headers.authorization,
      "Bearer fast-key",
    );
  });

  await t.test("read-only commands run without approval", async () => {
    const before = f.commands.length;
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[run] 看一下磁盘",
      autoRun: "read",
    });
    assert.equal(turn.status, 200, turn.body);
    assert.match(turn.type, /ndjson/);
    assert.equal(turn.events[0].type, "start");
    const tool = toolsOf(turn)[0];
    assert.equal(tool.name, "run_command");
    assert.equal(tool.state, "ok");
    assert.equal(tool.auto, true);
    assert.equal(tool.readOnly, true);
    assert.equal(turn.events.some((e) => e.type === "proposal"), false);
    assert.equal(
      f.commands.slice(before).some((command) => command.includes("df -h")),
      true,
    );
    const answer = turn.events.find((e) => e.type === "answer");
    assert.ok(answer.text.length > 0);
    assert.equal(turn.events.at(-1).type, "done");
    assert.equal(proposals(f).length, 0);
    const run = f.db
      .prepare("SELECT status,conversation_id,trace FROM ai_runs")
      .get();
    assert.equal(run.status, "completed");
    assert.ok(run.conversation_id);
    assert.ok(run.trace.length > 0);
  });

  await t.test("a long run finishes in one answer", async () => {
    // Twelve tool rounds: with the old eight-step cap this answer ended with
    // "已达到本次分析步数上限…" instead of the result.
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[loop] 把目录都看一遍",
      autoRun: "read",
    });
    assert.equal(turn.status, 200, turn.body);
    assert.equal(toolsOf(turn).length, 12);
    const answer = turn.events.find((e) => e.type === "answer").text;
    assert.equal(answer, "已生成配置修改与验证命令。");
    assert.equal(/步数上限|分析步数/.test(turn.body), false);
    assert.equal(turn.events.at(-1).type, "done");
  });

  await t.test("a dropped socket no longer interrupts the run", async () => {
    // `[slow]` leaves the second model call pending, `[pre]` streams a sentence
    // before the tool, and the abort mimics switching away (or refreshing)
    // mid-run. The run is detached from its request, so it must keep going, save
    // its answer, and finish on its own instead of being recorded as cancelled.
    const text = await chatUntil(
      f,
      {
        root: "/srv/app",
        message: "[slow][pre][run] 看一下磁盘",
        autoRun: "read",
      },
      (acc) => acc.includes('"type":"tool"'),
    );
    const events = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const start = events.find((e) => e.type === "start");
    assert.ok(start?.conversationId, text);
    // The socket is gone; the run is not. Wait for it to finish by itself.
    let last;
    for (let i = 0; i < 100; i += 1) {
      const detail = await request(f, `/api/ai/conversations/${start.conversationId}`);
      last = detail.body.turns.at(-1);
      if (last.status !== "running") break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(last.status, "completed", JSON.stringify(last));
    // The sentence written while the operator was away is kept, and so is the
    // step the run performed after the socket closed.
    assert.match(last.answer, /我先看一下磁盘占用。/);
    assert.ok(last.trace.length > 0);
  });

  await t.test("mutating commands wait for the operator", async () => {
    const before = f.commands.length;
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[write] 重启 nginx",
      autoRun: "read",
    });
    const card = turn.events.find((e) => e.type === "proposal");
    assert.equal(card.proposal.kind, "command");
    assert.equal(card.proposal.status, "pending");
    assert.equal(card.proposal.after, "systemctl restart nginx");
    assert.equal(toolsOf(turn)[0].state, "awaiting");
    assert.equal(f.commands.length, before);
    assert.equal(
      (await request(f, `/api/ai/machines/1/proposals/${card.proposal.id}/apply`, "POST", {
        confirm: true,
      })).status,
      200,
    );
    assert.equal(
      f.commands.slice(before).some((c) => c.includes("systemctl restart nginx")),
      true,
    );
    // Ignoring a card is final and never runs anything.
    const ignored = await chat(f, {
      root: "/srv/app",
      message: "[write] 重启 nginx",
      autoRun: "read",
    });
    const ignoredCard = ignored.events.find((e) => e.type === "proposal");
    const after = f.commands.length;
    assert.equal(
      (await request(
        f,
        `/api/ai/machines/1/proposals/${ignoredCard.proposal.id}/reject`,
        "POST",
        { confirm: true },
      )).status,
      200,
    );
    assert.equal(f.commands.length, after);
    assert.equal(
      (await request(
        f,
        `/api/ai/machines/1/proposals/${ignoredCard.proposal.id}/reject`,
        "POST",
        { confirm: true },
      )).status,
      409,
    );
    assert.equal(
      (await request(
        f,
        `/api/ai/machines/1/proposals/${ignoredCard.proposal.id}/apply`,
        "POST",
        { confirm: true },
      )).status,
      409,
    );
  });

  await t.test("dangerous commands are never auto-run", async () => {
    const before = f.commands.length;
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[danger] 清理目录",
      autoRun: "all",
    });
    const card = turn.events.find((e) => e.type === "proposal");
    assert.equal(card.proposal.status, "pending");
    assert.equal(card.proposal.after, "rm -rf /srv/app");
    assert.equal(f.commands.length, before);
  });

  await t.test("file writes apply, keep a backup and revert", async () => {
    const original = f.files.get("/srv/app/config.json").toString();
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[file] 更新配置",
      autoRun: "all",
    });
    const card = turn.events.find((e) => e.type === "proposal");
    assert.equal(card.proposal.kind, "file");
    assert.equal(card.proposal.status, "applied");
    assert.equal(card.proposal.before, original);
    assert.equal(f.files.get("/srv/app/config.json").toString(), '{"enabled":true}\n');
    assert.ok(
      [...f.files.keys()].some((key) => key.includes(".yaws-backup-")),
    );
    const reverted = await request(
      f,
      `/api/ai/machines/1/proposals/${card.proposal.id}/revert`,
      "POST",
      { confirm: true },
    );
    assert.equal(reverted.status, 200, JSON.stringify(reverted.body));
    assert.equal(f.files.get("/srv/app/config.json").toString(), original);
    assert.equal(
      (await request(f, `/api/ai/machines/1/proposals/${card.proposal.id}/revert`, "POST", {
        confirm: true,
      })).status,
      409,
    );
  });

  await t.test("file writes can also wait for approval", async () => {
    const original = f.files.get("/srv/app/config.json").toString();
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[file] 更新配置",
      autoRun: "read",
    });
    const card = turn.events.find((e) => e.type === "proposal");
    assert.equal(card.proposal.status, "pending");
    assert.equal(f.files.get("/srv/app/config.json").toString(), original);
  });

  await t.test("logs and stats are readable", async () => {
    const log = await chat(f, {
      root: "/srv/app",
      message: "[log] 看下错误日志",
      autoRun: "read",
    });
    assert.equal(toolsOf(log)[0].readOnly, true);
    const stats = await chat(f, {
      root: "/srv/app",
      message: "[stats] 服务器状态",
      autoRun: "read",
    });
    const statsTool = toolsOf(stats)[0];
    assert.equal(statsTool.name, "server_stats");
    assert.equal(statsTool.state, "ok");
  });

  await t.test("secrets are refused before they reach the model", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[secret] 读取环境变量",
      autoRun: "all",
    });
    const tool = toolsOf(turn)[0];
    assert.equal(tool.state, "error");
    assert.equal(tool.output, "sensitive_file_blocked");
    assert.equal(
      f.modelRequests.some((requestBody) =>
        JSON.stringify(requestBody).includes("SECRET"),
      ),
      false,
    );
  });

  await t.test("several tool calls in one turn all report", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[many] 全面检查",
      autoRun: "read",
    });
    const names = toolsOf(turn).map((tool) => tool.name);
    assert.deepEqual(names, ["run_command", "server_stats", "list_files"]);
    assert.equal(turn.events.at(-1).type, "done");
  });

  await t.test("the answer streams in as the model writes it", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[sse][md] 总结磁盘情况",
      autoRun: "read",
    });
    assert.equal(turn.status, 200, turn.body);
    assert.equal(
      f.modelRequests.at(-1).stream,
      true,
      "the chat call asks the model to stream",
    );
    const deltas = turn.events.filter((e) => e.type === "delta");
    assert.ok(
      deltas.length > 3,
      `expected many token deltas, got ${deltas.length}`,
    );
    const streamed = deltas.map((e) => e.text).join("");
    assert.equal(
      streamed,
      turn.events.find((e) => e.type === "answer").text,
      "the deltas add up to the final answer",
    );
    // Reasoning travels on its own channel so it never mixes with the answer.
    const thinking = turn.events
      .filter((e) => e.type === "thinking")
      .map((e) => e.text)
      .join("");
    assert.equal(thinking, "先看一下磁盘。");
    assert.equal(streamed.includes("先看一下磁盘"), false);
    const usage = turn.events.find((e) => e.type === "usage");
    assert.equal(usage.usage.promptTokens, 21);
    assert.equal(usage.usage.completionTokens, 8);
    assert.equal(usage.usage.totalTokens, 29);
    // The cached share of the prompt reaches the page for the hit-rate line.
    assert.equal(usage.usage.cachedTokens, 12);
    assert.equal(turn.events.at(-1).type, "done");
  });

  await t.test("a provider that reports no cache is not shown as a cache miss", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[nocache][sse][md] 再总结一次磁盘情况",
      autoRun: "read",
    });
    assert.equal(turn.status, 200, turn.body);
    const usage = turn.events.find((e) => e.type === "usage");
    assert.equal(usage.usage.totalTokens, 29);
    assert.equal(
      usage.usage.cachedTokens,
      null,
      "an unreported cache stays null so the page can hide the hit rate",
    );
    assert.equal(turn.events.at(-1).type, "done");
  });

  await t.test("tool calls are reassembled from streamed fragments", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[sse][run] 看一下磁盘",
      autoRun: "read",
    });
    const tool = toolsOf(turn)[0];
    assert.equal(tool.name, "run_command");
    assert.equal(tool.detail, "df -h /");
    assert.equal(tool.state, "ok", turn.body);
    assert.ok(
      turn.events.some((e) => e.type === "toolcall" && e.name === "run_command"),
      "the tool name is surfaced while its arguments stream",
    );
    assert.equal(turn.events.at(-1).type, "done");
  });

  await t.test("a streaming gateway that rejects stream_options still works", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[strict][sse][md] 换个端点再试",
      autoRun: "read",
    });
    assert.equal(turn.status, 200, turn.body);
    const answer = turn.events.find((e) => e.type === "answer");
    assert.match(answer.text, /磁盘排查结论/);
    // The retry drops the optional field, so no usage is reported and none is faked.
    assert.equal(turn.events.some((e) => e.type === "usage"), false);
    assert.equal(turn.events.at(-1).type, "done");
  });

  await t.test("the responses protocol streams the same way", async () => {
    assert.equal(
      (await request(f, "/api/ai/settings", "PUT", {
        ...settings(f),
        protocol: "responses",
      })).status,
      200,
    );
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[sse][run] 用 responses 协议看一下磁盘",
      autoRun: "read",
    });
    assert.equal(turn.status, 200, turn.body);
    const tool = toolsOf(turn)[0];
    assert.equal(tool.name, "run_command");
    assert.equal(tool.detail, "df -h /");
    assert.equal(tool.state, "ok", turn.body);
    const deltas = turn.events.filter((e) => e.type === "delta");
    assert.ok(deltas.length > 3, turn.body);
    assert.equal(
      deltas.map((e) => e.text).join(""),
      turn.events.find((e) => e.type === "answer").text,
    );
    assert.ok(turn.events.some((e) => e.type === "thinking"));
    const usage = turn.events.find((e) => e.type === "usage");
    assert.equal(usage.usage.cachedTokens, 12);
    assert.equal(turn.events.at(-1).type, "done");
    assert.ok(Array.isArray(f.modelRequests.at(-1).input));
    // Leave the chat protocol active for the tests that follow.
    assert.equal(
      (await request(f, "/api/ai/settings", "PUT", settings(f))).status,
      200,
    );
  });

  await t.test("an answer cut off at the output cap is finished", async () => {
    // Buffered provider first: `finish_reason: length` has to be noticed even
    // when the endpoint ignores `stream`.
    const plain = await chat(f, {
      root: "/srv/app",
      message: "[cut] 写一份很长的排查报告",
      autoRun: "read",
    });
    assert.equal(plain.status, 200, plain.body);
    const whole =
      "第一段：答案太长，在中间就被切开了" + "第二段：这是被截断后接着写完的结尾。";
    assert.equal(plain.events.find((e) => e.type === "answer").text, whole);
    const rounds = plain.events.filter((e) => e.type === "continuing");
    assert.equal(rounds.length, 1, plain.body);
    assert.equal(rounds[0].round, 1);
    // The operator sees one seamless answer: the deltas add up to the same text.
    assert.equal(
      plain.events
        .filter((e) => e.type === "delta")
        .map((e) => e.text)
        .join(""),
      whole,
    );
    // The second request replays the fragment as the model's own turn and asks
    // it to carry on, which is what makes providers continue instead of restart.
    const replay = f.modelRequests.at(-1).messages;
    assert.equal(replay.at(-2).role, "assistant");
    assert.equal(replay.at(-2).content, "第一段：答案太长，在中间就被切开了");
    assert.equal(replay.at(-1).role, "user");
    assert.match(replay.at(-1).content, /被截断了/);
    // A stopped run keeps the finished text, not the fragment.
    const runId = plain.events.find((e) => e.type === "start").runId;
    const stored = await request(f, `/api/ai/machines/1/runs/${runId}`);
    assert.equal(stored.status, 200);
    assert.equal(stored.body.answer, whole);

    // Streaming provider: the same, token by token.
    const streamed = await chat(f, {
      root: "/srv/app",
      message: "[cut][sse] 再写一份长报告",
      autoRun: "read",
    });
    assert.equal(streamed.status, 200, streamed.body);
    assert.equal(streamed.events.find((e) => e.type === "answer").text, whole);
    assert.equal(streamed.events.filter((e) => e.type === "continuing").length, 1);
    // The continuation is streamed token by token like the first part was, so
    // the operator watches one answer being written, not a fragment plus a dump.
    assert.ok(
      streamed.events.filter((e) => e.type === "delta").length > 8,
      streamed.body,
    );
    assert.equal(streamed.events.at(-1).type, "done");
  });

  await t.test("the responses protocol continues a cut answer too", async () => {
    assert.equal(
      (await request(f, "/api/ai/settings", "PUT", {
        ...settings(f),
        protocol: "responses",
      })).status,
      200,
    );
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[cut][sse] 用 responses 协议写长报告",
      autoRun: "read",
    });
    assert.equal(turn.status, 200, turn.body);
    assert.equal(
      turn.events.find((e) => e.type === "answer").text,
      "第一段：答案太长，在中间就被切开了" + "第二段：这是被截断后接着写完的结尾。",
    );
    assert.equal(turn.events.filter((e) => e.type === "continuing").length, 1);
    // `incomplete_details.reason` is the responses-API way of saying the same.
    assert.equal(f.modelRequests.at(-1).input.at(-2).role, "assistant");
    assert.match(f.modelRequests.at(-1).input.at(-1).content, /被截断了/);
    assert.equal(
      (await request(f, "/api/ai/settings", "PUT", settings(f))).status,
      200,
    );
  });

  await t.test("a model that never stops truncating is given up on", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[cutall] 写一份永远写不完的报告",
      autoRun: "read",
    });
    assert.equal(turn.status, 200, turn.body);
    // Every round is cut short, so the loop stops at its own limit instead of
    // asking the model forever, and the operator is told why.
    assert.equal(
      turn.events.filter((e) => e.type === "continuing").length,
      MAX_CONTINUATIONS,
    );
    const notes = turn.events.filter(
      (e) => e.type === "note" && e.note === "answer_truncated",
    );
    assert.equal(notes.length, 1, turn.body);
    const segments = Array.from(
      { length: MAX_CONTINUATIONS + 1 },
      (_, index) => `第 ${index + 1} 段。`,
    ).join("");
    assert.equal(turn.events.find((e) => e.type === "answer").text, segments);
    assert.equal(turn.events.at(-1).type, "done");
  });

  await t.test("conversations keep their history", async () => {
    const first = await chat(f, {
      root: "/srv/app",
      message: "[run] 第一次提问",
      autoRun: "read",
    });
    const start = first.events.find((e) => e.type === "start");
    assert.ok(start.conversationId);
    const list = await request(f, "/api/ai/conversations?machineId=1");
    assert.equal(list.status, 200);
    const row = list.body.conversations.find(
      (c) => c.id === start.conversationId,
    );
    assert.ok(row);
    assert.ok(row.turns >= 1);
    const second = await chat(f, {
      root: "/srv/app",
      message: "[run] 第二次提问",
      autoRun: "read",
      conversationId: start.conversationId,
    });
    assert.equal(
      second.events.find((e) => e.type === "start").conversationId,
      start.conversationId,
    );
    const prompts = f.modelRequests
      .at(-1)
      .messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    assert.equal(
      prompts.some((text) => text.includes("第一次提问")),
      true,
      "previous turn is replayed to the model",
    );
    const detail = await request(f, `/api/ai/conversations/${start.conversationId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.turns.length, 2);
    assert.equal(detail.body.turns[0].prompt, "[run] 第一次提问");
    assert.ok(detail.body.turns[0].answer.length > 0);
    assert.ok(detail.body.turns[0].trace.length > 0);
    assert.equal(
      (await request(f, `/api/ai/conversations/${start.conversationId}`, "DELETE"))
        .status,
      200,
    );
    assert.equal(
      (await request(f, `/api/ai/conversations/${start.conversationId}`)).status,
      404,
    );
  });

  await t.test("long conversations keep earlier turns in reach", async () => {
    const opening = await chat(f, {
      root: "/srv/app",
      message: "[md] 第1轮问题",
      autoRun: "read",
    });
    const id = opening.events.find((e) => e.type === "start").conversationId;
    for (let i = 2; i <= 8; i++)
      await chat(f, {
        root: "/srv/app",
        message: `[md] 第${i}轮问题`,
        autoRun: "read",
        conversationId: id,
      });
    const prompts = f.modelRequests
      .at(-1)
      .messages.filter((m) => m.role === "user")
      .map((m) => m.content);
    // The old six-turn window would have dropped the first question.
    assert.equal(prompts.length, 8);
    assert.equal(prompts[0], "[md] 第1轮问题");
    assert.equal(prompts.at(-1), "[md] 第8轮问题");
  });

  await t.test("chat is admin-only and validates input", async () => {
    const viewer = await fetch(`${f.url}/api/ai/machines/1/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.viewerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ root: "/srv/app", message: "hi" }),
    });
    assert.equal(viewer.status, 403);
    assert.equal(
      (
        await fetch(`${f.url}/api/ai/machines/1/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ root: "/srv/app", message: "hi" }),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${f.url}/api/ai/machines/1/chat`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ root: "/srv/app" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${f.url}/api/ai/machines/1/chat`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            root: "/srv/app",
            message: "hi",
            conversationId: "does-not-exist",
          }),
        })
      ).status,
      404,
    );
    const outside = await chat(f, {
      root: "/etc",
      message: "[list] 看看目录",
      autoRun: "read",
    });
    assert.equal(toolsOf(outside)[0].state, "error");
    assert.equal(toolsOf(outside)[0].output, "outside_workspace");
  });

  await t.test("legacy run endpoint still works", async () => {
    const run = await request(f, "/api/ai/machines/1/run", "POST", {
      root: "/srv/app",
      prompt: "Enable the config and propose validation.",
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.proposals.length, 2);
  });
});

/**
 * The run guard is what decides whether a long answer survives: it has to let a
 * slow model keep writing and only stop one that has gone silent. Small timeouts
 * are used so the assertion does not take ten minutes.
 */
test("a run is stopped for stalling, not for taking long", async (t) => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const guard = runGuard(40, 60_000);
  t.after(() => guard.stop());
  // Progress keeps it alive past every idle window.
  for (let round = 0; round < 5; round += 1) {
    await sleep(20);
    guard.reset();
    assert.equal(guard.signal.aborted, false);
  }
  // Silence, on the other hand, ends the run.
  await sleep(90);
  assert.equal(guard.tripped, true);
  assert.equal(guard.signal.aborted, true);
  // The hard ceiling fires even while work keeps arriving.
  const ceiling = runGuard(60_000, 30);
  t.after(() => ceiling.stop());
  await sleep(70);
  assert.equal(ceiling.tripped, true);
  // A tool that works for minutes without a word is progress, not a stall.
  const held = runGuard(40, 60_000);
  t.after(() => held.stop());
  held.pause();
  await sleep(90);
  assert.equal(held.signal.aborted, false);
  held.resume();
  await sleep(90);
  assert.equal(held.tripped, true);
  // A stopped guard never fires, so a finished run cannot be killed by it.
  const stopped = runGuard(20, 20);
  stopped.stop();
  await sleep(50);
  assert.equal(stopped.signal.aborted, false);
});
