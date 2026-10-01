import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { harness } from "./fixture.mjs";
import { officialModel } from "../dist/ai-official.js";
import {
  anthropicBaseUrl,
  anthropicFailure,
  anthropicFrames,
  anthropicModel,
} from "../dist/ai-anthropic.js";

/** Starts a throwaway stand-in for the Claude Messages API. */
async function relay(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    url: (path) => `http://127.0.0.1:${server.address().port}${path}`,
  };
}

const drain = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

/** Wraps a Messages API event the way the provider frames it on the wire. */
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const started = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 1 },
  },
};
const stopped = (reason) => [
  frame({
    type: "message_delta",
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: 7 },
  }),
  frame({ type: "message_stop" }),
];
const textBlock = (text) => [
  frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  frame({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  }),
  frame({ type: "content_block_stop", index: 0 }),
];
/** Answers every request with one streamed sentence. */
function speak(req, res, body) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(frame(started));
  res.write(textBlock("磁盘用了 50%。").join(""));
  res.write(stopped("end_turn").join(""));
  res.end();
}

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
  return { status: response.status, body: parsed, text };
}

async function chat(f, body) {
  const response = await fetch(`${f.url}/api/ai/machines/1/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    events: text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    body: text,
  };
}

const settings = (baseUrl) => ({
  baseUrl,
  model: "claude-sonnet-4-5",
  protocol: "anthropic",
  apiKey: "sk-ant-fixture",
  allowPrivate: true,
});

test("anthropic endpoints", async (t) => {
  await t.test("the base URL is reduced to the prefix the SDK appends to", () => {
    // The adapter always appends `/v1/messages`.
    assert.equal(anthropicBaseUrl("https://api.anthropic.com"), "https://api.anthropic.com");
    assert.equal(anthropicBaseUrl("https://api.anthropic.com/"), "https://api.anthropic.com");
    assert.equal(anthropicBaseUrl("https://api.anthropic.com/v1"), "https://api.anthropic.com");
    assert.equal(
      anthropicBaseUrl("https://api.anthropic.com/v1/messages"),
      "https://api.anthropic.com",
    );
    // A relay that mounts the API under its own prefix keeps that prefix.
    assert.equal(
      anthropicBaseUrl("https://relay.example.com/claude/v1"),
      "https://relay.example.com/claude",
    );
    assert.equal(
      anthropicBaseUrl("https://relay.example.com/claude/v1/messages?x=1"),
      "https://relay.example.com/claude",
    );
    assert.throws(() => anthropicBaseUrl("not a url"), /bad_ai_endpoint/);
  });

  await t.test("a named Claude model borrows the catalog's limits", () => {
    const known = anthropicModel({
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
    });
    const catalog = officialModel("anthropic", "claude-sonnet-4-5");
    assert.equal(known.provider, "anthropic");
    assert.equal(known.api, "anthropic-messages");
    assert.equal(known.id, "claude-sonnet-4-5");
    assert.equal(known.contextWindow, catalog.contextWindow);
    assert.equal(known.maxTokens, catalog.maxTokens);
    // An unknown name still works, on conservative defaults.
    const unknown = anthropicModel({
      baseUrl: "https://relay.example.com",
      model: "claude-internal-preview",
    });
    assert.equal(unknown.id, "claude-internal-preview");
    assert.equal(unknown.contextWindow, 200_000);
    assert.equal(unknown.maxTokens, 8_192);
    assert.equal(unknown.baseUrl, "https://relay.example.com");
  });

  await t.test("provider failures map onto the panel's error codes", () => {
    const failure = (errorMessage, stopReason = "error") =>
      anthropicFailure({ errorMessage, stopReason }).message;
    assert.equal(failure('401 {"type":"error"}'), "model_http_401");
    assert.equal(failure("429 rate limited"), "model_http_429");
    assert.equal(failure("500 <html>bad gateway</html>"), "model_http_500");
    // A 200 that never became a stream means the URL is not the API.
    assert.equal(
      failure("Anthropic stream ended without a stop reason"),
      "model_invalid_json",
    );
    assert.equal(failure("Connection error."), "model_network_error");
    assert.equal(failure(undefined, "aborted"), "cancelled");
    // What the reply turned out to be is reported when it is known, because
    // "unparseable data" describes nothing the user can act on.
    const shape = (reply) =>
      anthropicFailure({ stopReason: "error" }, reply).message;
    assert.equal(shape({ frames: 0, empty: true, error: false }), "model_no_answer");
    assert.equal(shape({ frames: 0, empty: false, error: false }), "model_invalid_json");
    assert.equal(shape({ frames: 3, empty: false, error: true }), "model_upstream_error");
    assert.equal(shape({ frames: 3, empty: false, error: false }), "model_network_error");
  });

  await t.test("a finished message replays as the frames a stream would send", () => {
    const frames = anthropicFrames({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [
        { type: "text", text: "磁盘用了 50%。" },
        { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "/srv" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    const events = frames
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.split("\n").at(-1).slice("data: ".length)));
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    );
    // Text and arguments arrive as deltas: the reader opens blocks empty and
    // finalizes a call from what it streamed, never from the opening frame.
    assert.equal(events[2].delta.text, "磁盘用了 50%。");
    assert.equal(events[5].delta.partial_json, '{"path":"/srv"}');
    assert.equal(events[7].delta.stop_reason, "tool_use");
    assert.equal(events[7].usage.output_tokens, 7);
    // Anything that is not a whole message is left to the reader.
    assert.equal(anthropicFrames("not json"), null);
    assert.equal(anthropicFrames({ type: "message_start" }), null);
  });

  const f = await harness();
  t.after(() => f.close());
  const inspected = await request(f, "/api/machines/1/workspace/host-key/inspect", "POST");
  assert.equal(inspected.status, 200, inspected.text);
  assert.equal(
    (await request(f, "/api/machines/1/workspace/host-key", "PUT", inspected.body)).status,
    200,
  );

  await t.test("a custom key talks to the Messages API", async () => {
    const seen = [];
    const api = await relay(async (req, res) => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(await drain(req)) });
      speak(req, res);
    });
    t.after(() => api.server.close());
    assert.equal((await request(f, "/api/ai/settings", "PUT", settings(`${api.base}/v1`))).status, 200);

    const turn = await chat(f, { root: "/srv/app", message: "磁盘怎么样", autoRun: "read" });
    assert.equal(turn.status, 200, turn.body);
    assert.equal(turn.events.find((e) => e.type === "answer").text, "磁盘用了 50%。");
    assert.equal(turn.events.at(-1).type, "done");
    // The adapter owns the request: `/v1/messages` under the configured base.
    assert.equal(seen[0].url, "/v1/messages?beta=true");
    assert.equal(seen[0].headers["x-api-key"], "sk-ant-fixture");
    assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(seen[0].body.model, "claude-sonnet-4-5");
    assert.equal(seen[0].body.stream, true);
    // The system prompt and tools travel the Messages way.
    assert.ok(
      seen[0].body.system.some((part) =>
        part.text.includes("YAWS, a server operations assistant"),
      ),
    );
    assert.ok(seen[0].body.tools.some((tool) => tool.name === "run_command"));

    // Usage is reported in the shape the usage panel already reads.
    const usage = turn.events.find((e) => e.type === "usage");
    assert.equal(usage.usage.promptTokens, 11);
    assert.equal(usage.usage.completionTokens, 7);
  });

  await t.test("the full endpoint URL pasted from the docs also works", async () => {
    const seen = [];
    const api = await relay(async (req, res) => {
      seen.push(req.url);
      speak(req, res);
    });
    t.after(() => api.server.close());
    assert.equal(
      (await request(f, "/api/ai/settings", "PUT", settings(`${api.base}/v1/messages`))).status,
      200,
    );
    const turn = await chat(f, { root: "/srv/app", message: "磁盘怎么样", autoRun: "read" });
    assert.equal(turn.status, 200, turn.body);
    // Not `/v1/messages/v1/messages`.
    assert.deepEqual(seen, ["/v1/messages?beta=true"]);
  });

  await t.test("a tool call comes back as a tool result on the next round", async () => {
    const rounds = [];
    const api = await relay(async (req, res) => {
      const body = JSON.parse(await drain(req));
      rounds.push(body);
      const first = rounds.length === 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(started));
      res.write(
        (first
          ? [
              frame({
                type: "content_block_start",
                index: 0,
                content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
              }),
              frame({
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: '{"path":"/srv/app/config.json"}' },
              }),
              frame({ type: "content_block_stop", index: 0 }),
            ]
          : textBlock("config.json 里 enabled 是 false。")
        ).join(""),
      );
      res.write(stopped(first ? "tool_use" : "end_turn").join(""));
      res.end();
    });
    t.after(() => api.server.close());
    assert.equal((await request(f, "/api/ai/settings", "PUT", settings(api.base))).status, 200);

    const turn = await chat(f, { root: "/srv/app", message: "配置里是什么", autoRun: "read" });
    assert.equal(turn.status, 200, turn.body);
    const tool = turn.events.filter((e) => e.type === "tool").at(-1).tool;
    assert.equal(tool.name, "read_file");
    assert.equal(tool.detail, "/srv/app/config.json");
    assert.equal(tool.state, "ok", turn.body);
    assert.equal(
      turn.events.find((e) => e.type === "answer").text,
      "config.json 里 enabled 是 false。",
    );
    // Round two replays the call as a `tool_use` block and the result as a
    // `tool_result` block, which is what the API requires.
    const replayed = rounds[1].messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.map((part) => part.type) : [],
    );
    assert.deepEqual(replayed, ["tool_use", "tool_result"]);
    const result = rounds[1].messages.at(-1).content[0];
    assert.equal(result.tool_use_id, "toolu_1");
    assert.equal(result.is_error, false);
  });

  await t.test("a relay that answers with the whole message instead of a stream", async () => {
    const api = await relay((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "磁盘用了 50%。" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 7 },
        }),
      );
    });
    t.after(() => api.server.close());
    assert.equal((await request(f, "/api/ai/settings", "PUT", settings(api.base))).status, 200);
    const turn = await chat(f, { root: "/srv/app", message: "磁盘怎么样", autoRun: "read" });
    assert.equal(turn.status, 200, turn.body);
    assert.equal(turn.events.find((e) => e.type === "answer").text, "磁盘用了 50%。");
    const usage = turn.events.find((e) => e.type === "usage");
    assert.equal(usage.usage.promptTokens, 11);
    assert.equal(usage.usage.completionTokens, 7);
  });

  await t.test("a relay that streams without SSE event names", async () => {
    // The official client dispatches on the JSON `type`, so plenty of relays
    // never write an `event:` line. pi's reader needs it, so it is restored.
    const payloads = [
      started,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "磁盘用了 50%。" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 7 },
      },
      { type: "message_stop" },
    ];
    const api = await relay((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.end();
    });
    t.after(() => api.server.close());
    assert.equal((await request(f, "/api/ai/settings", "PUT", settings(api.base))).status, 200);
    const turn = await chat(f, { root: "/srv/app", message: "磁盘怎么样", autoRun: "read" });
    assert.equal(turn.status, 200, turn.body);
    assert.equal(turn.events.find((e) => e.type === "answer").text, "磁盘用了 50%。");
  });

  await t.test("a relay that answers oddly reports why", async () => {
    const cases = [
      [
        "401",
        (req, res) => {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
        },
        "model_http_401",
      ],
      [
        "404",
        (req, res) => {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no route" } }));
        },
        "model_http_404",
      ],
      [
        "an HTML landing page",
        (req, res) => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<html><body>welcome</body></html>");
        },
        "model_invalid_json",
      ],
      [
        "an empty stream",
        (req, res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end();
        },
        "model_no_answer",
      ],
      [
        "an error object with a 200",
        (req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }),
          );
        },
        "model_upstream_error",
      ],
      [
        "an error written into the stream unframed",
        (req, res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(frame(started));
          res.write(`${JSON.stringify({ error: { type: "overloaded_error" } })}\n`);
          res.end();
        },
        "model_upstream_error",
      ],
    ];
    for (const [label, handler, code] of cases) {
      const api = await relay(handler);
      assert.equal((await request(f, "/api/ai/settings", "PUT", settings(api.base))).status, 200);
      const turn = await chat(f, { root: "/srv/app", message: "磁盘怎么样", autoRun: "read" });
      assert.equal(turn.status, 200, turn.body);
      const error = turn.events.find((e) => e.type === "error");
      assert.equal(error?.error, code, `${label}: ${turn.body}`);
      assert.equal(turn.events.some((e) => e.type === "answer"), false, label);
      api.server.close();
    }
  });

  await t.test("the old single-shot endpoint points at the chat page", async () => {
    const api = await relay(speak);
    t.after(() => api.server.close());
    assert.equal((await request(f, "/api/ai/settings", "PUT", settings(api.base))).status, 200);
    const run = await request(f, "/api/ai/machines/1/run", "POST", {
      root: "/srv/app",
      prompt: "磁盘怎么样",
    });
    assert.equal(run.status, 400);
    assert.equal(run.body.error, "anthropic_use_chat");
  });
});
