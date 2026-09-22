import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fixture.mjs";
import { runStreams, RunStreams, RUN_REPLAY_KEEP } from "../dist/ai-streams.js";

/**
 * A run must not live inside the HTTP request that started it.
 *
 * The failure this covers is the one an operator hits constantly: a page
 * refresh, a closed tab, or opening the same conversation in a second terminal
 * used to abort the model request and stop the SSH work, leaving a turn marked
 * `cancelled` and an answer cut off mid-sentence. The run is detached here, so
 * losing a reader is a non-event.
 */

test("detached run registry", async (t) => {
  await t.test("frames reach every reader, and a late one gets the replay", () => {
    const streams = new RunStreams();
    const run = streams.create({
      runId: "r1",
      conversationId: "c1",
      userId: 1,
      machineId: 1,
    });
    streams.emit(run, { type: "start", runId: "r1" });
    const early = [];
    const first = streams.attach("r1", (event) => early.push(event));
    assert.deepEqual(
      first.replay.map((event) => event.type),
      ["start"],
    );
    streams.emit(run, { type: "delta", text: "你好" });
    // The replay is handed back to the caller, which writes it; only frames
    // published after the attach reach the listener.
    assert.deepEqual(
      early.map((event) => event.type),
      ["delta"],
    );
    // A reader that arrives later still sees the whole answer from the start.
    const late = streams.attach("r1", () => {});
    assert.deepEqual(
      late.replay.map((event) => event.type),
      ["start", "delta"],
    );
    streams.detach(run, () => {});
  });

  await t.test("`after` skips the frames a reader already has", () => {
    const streams = new RunStreams();
    const run = streams.create({
      runId: "r1",
      conversationId: "c1",
      userId: 1,
      machineId: 1,
    });
    for (const text of ["a", "b", "c"])
      streams.emit(run, { type: "delta", text });
    // A reconnected client rendered two frames, so it must not be shown them
    // again — a duplicated answer is worse than a re-fetch.
    const resumed = streams.attach("r1", () => {}, 2);
    assert.deepEqual(
      resumed.replay.map((event) => event.text),
      ["c"],
    );
    // Counts beyond the end are clamped rather than throwing.
    assert.deepEqual(streams.attach("r1", () => {}, 99).replay, []);
    assert.equal(streams.attach("missing", () => {}), null);
  });

  await t.test("detaching a reader never stops the run", () => {
    const streams = new RunStreams();
    const run = streams.create({
      runId: "r1",
      conversationId: "c1",
      userId: 1,
      machineId: 1,
    });
    const seen = [];
    const listener = (event) => seen.push(event.type);
    streams.attach("r1", listener);
    streams.detach(run, listener);
    // The equivalent of the browser closing the socket: the registry keeps the
    // run, and it keeps accepting frames.
    streams.emit(run, { type: "delta", text: "还在写" });
    assert.equal(run.finished, false);
    assert.equal(streams.size, 1);
    assert.deepEqual(seen, []);
    // A reader attaching afterwards sees what happened while nobody watched.
    assert.equal(streams.attach("r1", () => {}).replay.length, 1);
  });

  await t.test("finishing releases readers and keeps the answer", () => {
    const streams = new RunStreams();
    const run = streams.create({
      runId: "r1",
      conversationId: "c1",
      userId: 1,
      machineId: 1,
    });
    const seen = [];
    streams.attach("r1", (event) => seen.push(event.type));
    streams.emit(run, { type: "answer", text: "完成了" });
    streams.finish(run);
    assert.equal(run.finished, true);
    assert.equal(streams.size, 0);
    // `stream_end` tells a live reader to close, and the record survives so a
    // refresh on the last token still gets the answer instead of a 404.
    assert.deepEqual(seen, ["answer", "stream_end"]);
    assert.deepEqual(
      streams.attach("r1", () => {}).replay.map((event) => event.type),
      ["answer"],
    );
  });

  await t.test("only an explicit abort stops a run", () => {
    const streams = new RunStreams();
    const run = streams.create({
      runId: "r1",
      conversationId: "c1",
      userId: 1,
      machineId: 1,
    });
    let stopped = 0;
    streams.onAbort(run, () => {
      stopped += 1;
    });
    // A closed socket must not register as a stop; there is no code path from
    // `detach` to `abort`, which is the property this test pins down.
    streams.attach("r1", () => {});
    streams.detach(run, () => {});
    assert.equal(stopped, 0);
    assert.equal(streams.abort("r1"), true);
    assert.equal(stopped, 1);
    // Stopping twice, or after the run ended, is a no-op rather than an error.
    streams.finish(run);
    assert.equal(streams.abort("r1"), false);
    assert.equal(stopped, 1);
    // Registering after the end still fires, so nothing is left dangling.
    streams.onAbort(run, () => {
      stopped += 1;
    });
    assert.equal(stopped, 2);
  });

  await t.test("a throwing reader is dropped, not fatal", () => {
    const streams = new RunStreams();
    const run = streams.create({
      runId: "r1",
      conversationId: "c1",
      userId: 1,
      machineId: 1,
    });
    streams.attach("r1", () => {
      throw new Error("closed socket");
    });
    const healthy = [];
    streams.attach("r1", (event) => healthy.push(event.type));
    // One dead reader must not stop the run from reaching the live one.
    streams.emit(run, { type: "delta", text: "x" });
    assert.deepEqual(healthy, ["delta"]);
    assert.equal(run.listeners.size, 1);
  });

  await t.test("the replay is bounded", () => {
    const streams = new RunStreams();
    const run = streams.create({
      runId: "r1",
      conversationId: "c1",
      userId: 1,
      machineId: 1,
    });
    for (let i = 0; i < RUN_REPLAY_KEEP + 50; i++)
      streams.emit(run, { type: "delta", text: String(i) });
    assert.equal(run.replay.length, RUN_REPLAY_KEEP);
    // The tail is kept, so a late reader still sees the newest frames.
    assert.equal(run.replay.at(-1).text, String(RUN_REPLAY_KEEP + 49));
  });

  await t.test("finished runs do not pile up", () => {
    const streams = new RunStreams();
    const made = [];
    for (let i = 0; i < 80; i += 1) {
      const run = streams.create({
        runId: `r${i}`,
        conversationId: `c${i}`,
        userId: 1,
        machineId: 1,
      });
      streams.emit(run, { type: "answer", text: "done" });
      streams.finish(run);
      made.push(run);
    }
    // Creating run 81 prunes the oldest finished ones; the newest are still there
    // so a refresh on the last token still finds its answer.
    streams.create({ runId: "last", conversationId: "c", userId: 1, machineId: 1 });
    assert.equal(streams.get("last").finished, false);
    assert.ok(streams.get(made.at(-1).runId), "the newest finished run is kept");
    assert.equal(streams.get(made[0].runId), undefined);
    // A running run is never pruned, however many finished ones come after it.
    const live = streams.create({
      runId: "live",
      conversationId: "clive",
      userId: 1,
      machineId: 1,
    });
    for (let i = 0; i < 200; i += 1)
      streams.create({ runId: `x${i}`, conversationId: `x${i}`, userId: 1, machineId: 1 });
    assert.equal(streams.get("live"), live);
    assert.equal(live.finished, false);
  });

  await t.test("finishing stamps the time it was pruned by", () => {
    const streams = new RunStreams();
    const run = streams.create({
      runId: "r1",
      conversationId: "c1",
      userId: 1,
      machineId: 1,
    });
    assert.equal(run.finishedAt, 0);
    streams.finish(run);
    assert.ok(run.finishedAt > 0);
  });

  await t.test("deleting a conversation drops all of its runs", () => {
    const streams = new RunStreams();
    streams.create({ runId: "r1", conversationId: "c1", userId: 1, machineId: 1 });
    streams.create({ runId: "r2", conversationId: "c1", userId: 1, machineId: 1 });
    streams.create({ runId: "r3", conversationId: "c2", userId: 1, machineId: 1 });
    streams.forgetConversation("c1");
    assert.equal(streams.get("r1"), undefined);
    assert.equal(streams.get("r2"), undefined);
    assert.ok(streams.get("r3"), "another conversation is untouched");
  });
});

test("a run survives the request that started it", async (t) => {
  const f = await harness();
  t.after(async () => {
    await f.close();
  });
  const auth = {
    authorization: `Bearer ${f.token}`,
    "content-type": "application/json",
  };
  // A configured model is a precondition for any chat at all, plus a verified
  // host key, exactly as the other chat tests set up.
  await fetch(`${f.url}/api/ai/settings`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({
      baseUrl: f.modelUrl,
      model: "fixture-model",
      protocol: "chat",
      apiKey: "fixture-key",
      allowPrivate: true,
    }),
  });
  const inspected = await fetch(
    `${f.url}/api/machines/1/workspace/host-key/inspect`,
    { method: "POST", headers: auth },
  );
  await fetch(`${f.url}/api/machines/1/workspace/host-key`, {
    method: "PUT",
    headers: auth,
    body: await inspected.text(),
  });
  await fetch(`${f.url}/api/machines/2/workspace/host-key/inspect`, {
    method: "POST",
    headers: auth,
  }).then(async (key) =>
    fetch(`${f.url}/api/machines/2/workspace/host-key`, {
      method: "PUT",
      headers: auth,
      body: await key.text(),
    }),
  );

  /** Reads frames until `match` sees one, or the stream ends. */
  async function readUntil(response, match, limit = 400) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buffer = "";
    for (let frame = 0; frame < limit; frame += 1) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        events.push(event);
        if (match(event)) {
          await reader.cancel();
          return events;
        }
      }
    }
    return events;
  }

  await t.test("closing the socket leaves the run going", async () => {
    // `[hold]` makes the model take a couple of seconds, which is the window a
    // refresh falls into.
    const started = await fetch(`${f.url}/api/ai/machines/1/chat`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        message: "[hold] 看一下磁盘",
        root: "/srv",
      }),
    });
    assert.equal(started.status, 200);
    // Read only the `start` frame, then hang up the way a reload does.
    const events = await readUntil(started, (event) => event.type === "start");
    const start = events.find((event) => event.type === "start");
    assert.ok(start, "the run announced itself");
    const conversationId = start.conversationId;
    const runId = start.runId;
    assert.ok(runStreams.get(runId), "the run is registered outside the request");
    assert.equal(runStreams.get(runId).finished, false);

    // The stored row is still `running`, and the conversation reports the live
    // run so a reloaded page knows what to attach to.
    const detail = await (
      await fetch(`${f.url}/api/ai/conversations/${conversationId}`, {
        headers: auth,
      })
    ).json();
    assert.equal(detail.liveRunId, runId);
    assert.equal(detail.turns.at(-1).status, "running");

    // Re-attach and read to the end: the whole answer is there, including the
    // tokens produced while nobody was connected.
    const again = await fetch(
      `${f.url}/api/ai/conversations/${conversationId}/runs/${runId}/stream`,
      { headers: auth },
    );
    assert.equal(again.status, 200);
    const replayed = await readUntil(
      again,
      (event) => event.type === "done" || event.type === "error",
      2000,
    );
    const types = replayed.map((event) => event.type);
    assert.ok(types.includes("delta"), "the answer streamed to the new reader");
    assert.ok(types.includes("done"), "and the run finished normally");
    assert.equal(replayed.some((event) => event.type === "error"), false);
    // Nothing is missing: the answer is complete, not a fragment.
    const text = replayed
      .filter((event) => event.type === "delta")
      .map((event) => event.text)
      .join("");
    const answer = replayed.find((event) => event.type === "answer");
    assert.ok(answer, "the full text was sent at the end");
    assert.equal(text, answer.text);
    assert.ok(text.length > 0);

    // The row is completed now, and there is nothing left to attach to.
    const after = await (
      await fetch(`${f.url}/api/ai/conversations/${conversationId}`, {
        headers: auth,
      })
    ).json();
    assert.equal(after.liveRunId, "");
    assert.equal(after.turns.at(-1).status, "completed");

    // Attaching to a finished run still replays what happened rather than 404s.
    const late = await fetch(
      `${f.url}/api/ai/conversations/${conversationId}/runs/${runId}/stream`,
      { headers: auth },
    );
    assert.equal(late.status, 200);
    const tail = await readUntil(late, () => false, 2000);
    assert.ok(tail.some((event) => event.type === "answer"));
  });

  await t.test("two conversations ask at once and neither is cut short", async () => {
    // The panel issue: a second terminal must be able to ask its own question
    // while the first one is still thinking, on the same machine.
    const ask = (machineId, message) =>
      fetch(`${f.url}/api/ai/machines/${machineId}/chat`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ message, root: "/srv" }),
      }).then((response) =>
        readUntil(
          response,
          (event) => event.type === "done" || event.type === "error",
          2000,
        ),
      );
    const [one, two] = await Promise.all([
      ask(1, "[hold] 第一台机器的问题"),
      ask(2, "[hold] 第二台机器的问题"),
    ]);
    for (const events of [one, two]) {
      assert.ok(events.some((event) => event.type === "answer"));
      assert.equal(events.some((event) => event.type === "error"), false);
    }
    // Both runs are finished, so the registry is clean afterwards.
    assert.equal(runStreams.size, 0);
  });

  await t.test("stopping is explicit, not a side effect of hanging up", async () => {
    const started = await fetch(`${f.url}/api/ai/machines/1/chat`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ message: "[hold] 开始一个长任务", root: "/srv" }),
    });
    const events = await readUntil(started, (event) => event.type === "start");
    const start = events.find((event) => event.type === "start");
    assert.ok(start);
    // Hang up first: the run must not be affected.
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(runStreams.get(start.runId).finished, false);
    const stopped = await fetch(
      `${f.url}/api/ai/conversations/${start.conversationId}/runs/${start.runId}/stop`,
      { method: "POST", headers: auth, body: JSON.stringify({ confirm: true }) },
    );
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).stopped, true);
    // The run ends through the stop, and the row records the cancellation.
    for (let i = 0; i < 100 && !runStreams.get(start.runId)?.finished; i += 1)
      await new Promise((done) => setTimeout(done, 50));
    assert.equal(runStreams.get(start.runId).finished, true);
    const detail = await (
      await fetch(`${f.url}/api/ai/conversations/${start.conversationId}`, {
        headers: auth,
      })
    ).json();
    assert.equal(detail.turns.at(-1).status, "cancelled");
  });

  await t.test("a conversation with a live run refuses to be deleted", async () => {
    const started = await fetch(`${f.url}/api/ai/machines/1/chat`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ message: "[hold] 正在跑的一轮", root: "/srv" }),
    });
    const events = await readUntil(started, (event) => event.type === "start");
    const start = events.find((event) => event.type === "start");
    assert.ok(start);
    // Deleting now would pull the rows out from under a run that is still
    // writing them, so it is refused with a reason the UI turns into a sentence.
    const refused = await fetch(
      `${f.url}/api/ai/conversations/${start.conversationId}`,
      { method: "DELETE", headers: auth },
    );
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, "run_running");
    // The row is still there.
    const detail = await fetch(
      `${f.url}/api/ai/conversations/${start.conversationId}`,
      { headers: auth },
    );
    assert.equal(detail.status, 200);
    // Stop it, and the delete goes through and drops its run record.
    await fetch(
      `${f.url}/api/ai/conversations/${start.conversationId}/runs/${start.runId}/stop`,
      { method: "POST", headers: auth, body: JSON.stringify({ confirm: true }) },
    );
    for (let i = 0; i < 100 && !runStreams.get(start.runId)?.finished; i += 1)
      await new Promise((done) => setTimeout(done, 50));
    const removed = await fetch(
      `${f.url}/api/ai/conversations/${start.conversationId}`,
      { method: "DELETE", headers: auth },
    );
    assert.equal(removed.status, 200);
    assert.equal(runStreams.get(start.runId), undefined);
  });

  await t.test("another operator cannot read or stop the run", async () => {
    const started = await fetch(`${f.url}/api/ai/machines/1/chat`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ message: "[hold] 私有的一轮", root: "/srv" }),
    });
    const events = await readUntil(started, (event) => event.type === "start");
    const start = events.find((event) => event.type === "start");
    assert.ok(start);
    // The viewer is a real account, but the assistant is admin-only and the
    // conversation is not theirs; either refusal is fine, and neither may leak
    // the stream.
    const viewer = { authorization: `Bearer ${f.viewerToken}` };
    const stream = await fetch(
      `${f.url}/api/ai/conversations/${start.conversationId}/runs/${start.runId}/stream`,
      { headers: viewer },
    );
    assert.ok([403, 404].includes(stream.status), String(stream.status));
    const stop = await fetch(
      `${f.url}/api/ai/conversations/${start.conversationId}/runs/${start.runId}/stop`,
      { method: "POST", headers: viewer, body: JSON.stringify({ confirm: true }) },
    );
    assert.ok([403, 404].includes(stop.status), String(stop.status));
    // A run id that belongs to another conversation cannot be smuggled in.
    const mismatched = await fetch(
      `${f.url}/api/ai/conversations/not-a-conversation/runs/${start.runId}/stream`,
      { headers: auth },
    );
    assert.equal(mismatched.status, 404);
    // Clean up the run this test started.
    await fetch(
      `${f.url}/api/ai/conversations/${start.conversationId}/runs/${start.runId}/stop`,
      { method: "POST", headers: auth, body: JSON.stringify({ confirm: true }) },
    );
  });
});
