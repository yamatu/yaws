import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fixture.mjs";
import { historyPrompt, imageMatches } from "../dist/ai-attachments.js";
import { toContext } from "../dist/ai-official.js";

// 1×1 transparent PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]).toString("base64");

async function request(f, url, method = "GET", body) {
  const response = await fetch(f.url + url, {
    method,
    headers: {
      authorization: `Bearer ${f.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get("content-type") ?? "";
  const raw = Buffer.from(await response.arrayBuffer());
  let parsed = raw;
  if (type.includes("json")) parsed = JSON.parse(raw.toString("utf8"));
  return { status: response.status, type, body: parsed };
}

/** Streams one chat turn; `onEvent` may act mid-run (e.g. steer). */
async function chatStream(f, body, onEvent = async () => {}) {
  const response = await fetch(`${f.url}/api/ai/machines/1/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) return { status: response.status, events: [], body: await response.text() };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push(event);
      await onEvent(event);
    }
  }
  return { status: response.status, events };
}

const userMessages = (req) => (req.messages ?? []).filter((m) => m.role === "user");

test("steering and pictures", async (t) => {
  const f = await harness();
  t.after(() => f.close());
  assert.equal(
    (
      await request(f, "/api/ai/settings", "PUT", {
        baseUrl: f.modelUrl,
        model: "fixture-model",
        protocol: "chat",
        apiKey: "fixture-key",
        allowPrivate: true,
      })
    ).status,
    200,
  );
  const inspected = await request(f, "/api/machines/1/workspace/host-key/inspect", "POST");
  assert.equal((await request(f, "/api/machines/1/workspace/host-key", "PUT", inspected.body)).status, 200);
  const base = { root: "/srv/app", autoRun: "read" };

  await t.test("a message sent mid-run reaches the model after the running step", async () => {
    const before = f.modelRequests.length;
    let steered;
    const turn = await chatStream(f, { ...base, message: "[slow][run] 看一下磁盘" }, async (event) => {
      if (event.type !== "start") return;
      steered = await request(
        f,
        `/api/ai/conversations/${event.conversationId}/runs/${event.runId}/steer`,
        "POST",
        { message: "顺便也看下内存" },
      );
    });
    assert.equal(steered.status, 200, JSON.stringify(steered.body));
    const steer = turn.events.find((event) => event.type === "steer");
    assert.equal(steer.steer.text, "顺便也看下内存");
    assert.equal(steer.steer.step, 1);
    assert.ok(turn.events.some((event) => event.type === "done"));
    // The second model call sees the tool result, then the new message.
    const second = f.modelRequests[before + 1];
    const tail = second.messages.slice(-2);
    assert.equal(tail[0].role, "tool");
    assert.deepEqual(tail[1], { role: "user", content: "顺便也看下内存" });

    const start = turn.events.find((event) => event.type === "start");
    const stored = await request(f, `/api/ai/conversations/${start.conversationId}`);
    assert.equal(stored.body.turns[0].steers[0].text, "顺便也看下内存");
    assert.equal(stored.body.turns[0].steers[0].step, 1);

    // Too late: the run is over, the page sends it as a new question instead.
    const late = await request(
      f,
      `/api/ai/conversations/${start.conversationId}/runs/${start.runId}/steer`,
      "POST",
      { message: "还有吗" },
    );
    assert.equal(late.status, 409);
    assert.equal(late.body.error, "run_not_steerable");

    // A later question replays the steered message as part of that turn.
    const before2 = f.modelRequests.length;
    await chatStream(f, { ...base, conversationId: start.conversationId, message: "谢谢" });
    const replayed = userMessages(f.modelRequests[before2])[0].content;
    assert.match(replayed, /\[运行中补充\] 顺便也看下内存/);
  });

  await t.test("a message that arrives before the final answer keeps the turn going", async () => {
    const before = f.modelRequests.length;
    const turn = await chatStream(f, { ...base, message: "[slow][md] 你好" }, async (event) => {
      if (event.type !== "start") return;
      await request(
        f,
        `/api/ai/conversations/${event.conversationId}/runs/${event.runId}/steer`,
        "POST",
        { message: "[md] 用一句话回答" },
      );
    });
    const steer = turn.events.find((event) => event.type === "steer");
    assert.equal(steer.steer.step, 0);
    assert.equal(f.modelRequests.length - before, 2);
    const last = f.modelRequests.at(-1).messages.at(-1);
    assert.deepEqual(last, { role: "user", content: "[md] 用一句话回答" });
  });

  await t.test("pictures go to the model with the question and are kept", async () => {
    const before = f.modelRequests.length;
    const turn = await chatStream(f, {
      ...base,
      message: "这个报错是什么意思",
      images: [{ mime: "image/png", data: PNG }],
    });
    assert.equal(turn.status, 200);
    const content = userMessages(f.modelRequests[before]).at(-1).content;
    assert.deepEqual(content, [
      { type: "text", text: "这个报错是什么意思" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
    ]);
    const start = turn.events.find((event) => event.type === "start");
    const stored = await request(f, `/api/ai/conversations/${start.conversationId}`);
    const [imageId] = stored.body.turns[0].images;
    assert.ok(imageId);
    const image = await request(f, `/api/ai/conversations/${start.conversationId}/images/${imageId}`);
    assert.equal(image.status, 200);
    assert.equal(image.type, "image/png");
    assert.deepEqual(image.body, Buffer.from(PNG, "base64"));
    // Another conversation's id cannot reach it.
    const other = await request(f, `/api/ai/conversations/nope/images/${imageId}`);
    assert.equal(other.status, 404);

    // Later turns mention the picture instead of paying for it again.
    const before2 = f.modelRequests.length;
    await chatStream(f, { ...base, conversationId: start.conversationId, message: "怎么修" });
    const history = userMessages(f.modelRequests[before2]);
    assert.equal(typeof history[0].content, "string");
    assert.match(history[0].content, /附带了 1 张图片/);
  });

  await t.test("a picture alone is a question; a mislabelled one is refused", async () => {
    const before = f.modelRequests.length;
    const turn = await chatStream(f, { ...base, images: [{ mime: "image/png", data: PNG }] });
    assert.equal(turn.status, 200);
    assert.equal(userMessages(f.modelRequests[before]).at(-1).content[0].text, "请查看我附上的图片。");

    const wrong = await chatStream(f, { ...base, message: "看图", images: [{ mime: "image/png", data: JPEG_HEAD }] });
    assert.equal(wrong.status, 400);
    const empty = await chatStream(f, { ...base, message: "  " });
    assert.equal(empty.status, 400);
    const many = await chatStream(f, {
      ...base,
      message: "看图",
      images: Array.from({ length: 5 }, () => ({ mime: "image/png", data: PNG })),
    });
    assert.equal(many.status, 400);
  });

  await t.test("deleting a conversation removes its pictures", async () => {
    const turn = await chatStream(f, { ...base, message: "图", images: [{ mime: "image/png", data: PNG }] });
    const start = turn.events.find((event) => event.type === "start");
    assert.equal((await request(f, `/api/ai/conversations/${start.conversationId}`, "DELETE")).status, 200);
    const left = f.db
      .prepare("SELECT COUNT(*) AS n FROM ai_images WHERE conversation_id = ?")
      .get(start.conversationId).n;
    assert.equal(left, 0);
  });
});

test("Messages and official models get pictures as pi image content", () => {
  const context = toContext(
    {
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "看图" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
          ],
        },
        { role: "user", content: "纯文本" },
      ],
    },
    { provider: "anthropic", id: "claude", api: "anthropic-messages" },
  );
  assert.deepEqual(context.messages[0].content, [
    { type: "text", text: "看图" },
    { type: "image", mimeType: "image/png", data: PNG },
  ]);
  assert.equal(context.messages[1].content, "纯文本");
});

test("image signatures and history wording", () => {
  assert.equal(imageMatches({ mime: "image/png", data: PNG }), true);
  assert.equal(imageMatches({ mime: "image/jpeg", data: JPEG_HEAD }), true);
  assert.equal(imageMatches({ mime: "image/jpeg", data: PNG }), false);
  assert.equal(imageMatches({ mime: "text/html", data: PNG }), false);
  assert.equal(historyPrompt("问题", 0, []), "问题");
  assert.match(
    historyPrompt("", 2, [{ text: "补充", images: ["a"], step: 1, at: 0 }]),
    /请查看我附上的图片。[\s\S]*2 张图片[\s\S]*\[运行中补充\] 补充[\s\S]*1 张图片/,
  );
});
