import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fixture.mjs";

/** Chat replies arrive as newline delimited JSON. */
async function chat(f, body, token = f.token, machineId = 1) {
  const response = await fetch(`${f.url}/api/ai/machines/${machineId}/chat`, {
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
    events: text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    body: text,
  };
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
  return { status: response.status, body: parsed };
}

/** Every tool card appears twice (running, then the result); keep the last state. */
function toolsOf(turn) {
  const latest = new Map();
  for (const event of turn.events)
    if (event.type === "tool") latest.set(event.tool.id, event.tool);
  return [...latest.values()];
}

const answerOf = (turn) =>
  turn.events.filter((event) => event.type === "answer").at(-1)?.text ?? "";

const settings = (f) => ({
  baseUrl: f.modelUrl,
  model: "fixture-model",
  protocol: "chat",
  apiKey: "fixture-key",
  allowPrivate: true,
});

/** The workspace refuses to touch a host with an unverified host key. */
async function trust(f, machineId) {
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

test("multi-host chat", async (t) => {
  const f = await harness();
  t.after(() => f.close());
  assert.equal(
    (await request(f, "/api/ai/settings", "PUT", settings(f))).status,
    200,
  );
  for (const id of [1, 2, 3]) await trust(f, id);

  await t.test("a turn runs on a selected extra host", async () => {
    const before = f.commands.length;
    const turn = await chat(f, {
      root: "/srv/app",
      message: '[tool:run_command {"command":"df -h /","host":"Fixture 3"}]',
      autoRun: "read",
      hosts: [2, 3],
    });
    assert.equal(turn.status, 200, turn.body);
    const tool = toolsOf(turn).find((step) => step.name === "run_command");
    assert.ok(tool, "the command card is in the transcript");
    assert.equal(tool.host, "Fixture 3 (#3)");
    assert.equal(tool.state, "ok");
    // The command really went over SSH: the fixture records every exec.
    assert.equal(f.commands.length, before + 1);
    assert.equal(f.commands.at(-1).includes("df -h /"), true);
  });

  await t.test("hosts are stored on the conversation and reported back", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[tool:list_hosts {}]",
      autoRun: "read",
      hosts: [2, 3],
    });
    const start = turn.events.find((event) => event.type === "start");
    assert.match(toolsOf(turn)[0].output, /Fixture 1 \(#1\)/);
    assert.match(toolsOf(turn)[0].output, /Fixture 3 \(#3\)/);

    const list = await request(f, "/api/ai/conversations?machineId=1");
    const row = list.body.conversations.find(
      (item) => item.id === start.conversationId,
    );
    assert.deepEqual(
      row.hosts.map((host) => host.name),
      ["Fixture 2", "Fixture 3"],
    );

    const detail = await request(f, `/api/ai/conversations/${start.conversationId}`);
    assert.deepEqual(
      detail.body.conversation.hosts.map((host) => host.id),
      [2, 3],
    );

    // A follow-up without a `hosts` field keeps the stored set, so an older
    // client (or a page reload) does not silently drop back to one machine.
    const kept = await chat(f, {
      conversationId: start.conversationId,
      root: "/srv/app",
      message: "[tool:list_hosts {}]",
      autoRun: "read",
    });
    assert.match(toolsOf(kept)[0].output, /Fixture 3 \(#3\)/);

    // An explicit empty list clears the extras again.
    const cleared = await chat(f, {
      conversationId: start.conversationId,
      root: "/srv/app",
      message: "[tool:list_hosts {}]",
      autoRun: "read",
      hosts: [],
    });
    assert.equal(toolsOf(cleared)[0].output, "Fixture 1 (#1)");
  });

  await t.test("run_on_hosts fans out one read-only command", async () => {
    const before = f.commands.length;
    const turn = await chat(f, {
      root: "/srv/app",
      message:
        '[tool:run_on_hosts {"command":"uptime","purpose":"检查负载"}]',
      autoRun: "read",
      hosts: [2, 3],
    });
    const tool = toolsOf(turn).find((step) => step.name === "run_on_hosts");
    assert.ok(tool);
    assert.equal(tool.state, "ok");
    assert.equal(tool.host, "3 台主机");
    assert.equal(tool.detail, "uptime");
    // One SSH exec per host, not one shared connection.
    assert.equal(f.commands.length, before + 3);
    // The model receives the per-host results, so it can compare the answers.
    const toolMessage = f.modelRequests
      .at(-1)
      .messages.find((message) => message.role === "tool");
    const payload = JSON.parse(toolMessage.content);
    assert.deepEqual(
      payload.results.map((item) => item.host),
      ["Fixture 1 (#1)", "Fixture 2 (#2)", "Fixture 3 (#3)"],
    );
    assert.equal(payload.results[0].exitCode, 0);
    assert.match(payload.results[0].output, /fixture command complete/);
  });

  await t.test("run_on_hosts refuses anything that changes a server", async () => {
    const before = f.commands.length;
    const turn = await chat(f, {
      root: "/srv/app",
      message: '[tool:run_on_hosts {"command":"systemctl restart nginx"}]',
      autoRun: "all",
      hosts: [2, 3],
    });
    const tool = toolsOf(turn).find((step) => step.name === "run_on_hosts");
    assert.equal(tool.state, "error");
    assert.match(tool.output, /只读/);
    assert.equal(f.commands.length, before, "nothing ran on any host");
    assert.equal(f.db.prepare("SELECT COUNT(*) as n FROM ai_proposals").get().n, 0);
  });

  await t.test("an unknown host is refused, not guessed", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message: '[tool:run_command {"command":"uptime","host":"Fixture 9"}]',
      autoRun: "read",
      hosts: [2],
    });
    const tool = toolsOf(turn).find((step) => step.name === "run_command");
    assert.equal(tool.state, "error");
    assert.equal(tool.output, "host_not_found");

    // A machine that exists but was not selected for this conversation is just
    // as out of reach as a machine that does not exist at all.
    const other = await chat(f, {
      root: "/srv/app",
      message: '[tool:run_command {"command":"uptime","host":3}]',
      autoRun: "read",
      hosts: [2],
    });
    assert.equal(
      toolsOf(other).find((step) => step.name === "run_command").output,
      "host_not_found",
    );
  });

  await t.test("a request for a non-existent host changes nothing", async () => {
    const rows = () =>
      f.db.prepare("SELECT COUNT(*) as n FROM ai_conversations").get().n;
    const before = rows();
    const turn = await chat(f, {
      root: "/srv/app",
      message: "你好",
      autoRun: "read",
      hosts: [2, 99],
    });
    assert.equal(turn.status, 404);
    assert.match(turn.body, /machine_not_found/);
    assert.equal(rows(), before, "no conversation row was created");

    const tooMany = await chat(f, {
      root: "/srv/app",
      message: "你好",
      autoRun: "read",
      hosts: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body, /bad_request/);
  });

  await t.test("a write on an extra host is confirmed per host", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message:
        '[tool:write_file {"path":"/srv/app/extra.conf","content":"port 8080\\n","summary":"改端口","host":2}]',
      autoRun: "read",
      hosts: [2],
    });
    const tool = toolsOf(turn).find((step) => step.name === "write_file");
    assert.equal(tool.state, "awaiting");
    assert.equal(tool.host, "Fixture 2 (#2)");
    const proposal = turn.events.find((event) => event.type === "proposal").proposal;
    assert.equal(proposal.host, "Fixture 2");
    assert.equal(proposal.path, "/srv/app/extra.conf");

    const stored = f.db
      .prepare("SELECT machine_id, status FROM ai_proposals WHERE id = ?")
      .get(proposal.id);
    assert.equal(stored.machine_id, 2, "the card remembers its host");
    assert.equal(stored.status, "pending");

    // The run itself still belongs to machine 1, which is where the ownership
    // check happens, but applying goes to the card's own host.
    const applied = await request(
      f,
      `/api/ai/machines/1/proposals/${proposal.id}/apply`,
      "POST",
      { confirm: true },
    );
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(
      f.files.get("/srv/app/extra.conf")?.toString().includes("port 8080"),
      true,
      "the file landed on the host the card named",
    );
    const reverted = await request(
      f,
      `/api/ai/machines/1/proposals/${proposal.id}/revert`,
      "POST",
      { confirm: true },
    );
    assert.equal(reverted.status, 200, JSON.stringify(reverted.body));
  });

  await t.test("a command on an extra host is proposed and applied there", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message:
        '[tool:run_command {"command":"systemctl restart nginx","purpose":"重启","host":3}]',
      autoRun: "read",
      hosts: [3],
    });
    const proposal = turn.events.find((event) => event.type === "proposal").proposal;
    assert.equal(proposal.host, "Fixture 3");
    assert.equal(
      f.db.prepare("SELECT machine_id FROM ai_proposals WHERE id = ?").get(proposal.id)
        .machine_id,
      3,
    );
    const before = f.commands.length;
    const applied = await request(
      f,
      `/api/ai/machines/1/proposals/${proposal.id}/apply`,
      "POST",
      { confirm: true },
    );
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(f.commands.length, before + 1);
  });

  await t.test("another operator cannot confirm the card", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message:
        '[tool:write_file {"path":"/srv/app/mine.conf","content":"a\\n","host":2}]',
      autoRun: "read",
      hosts: [2],
    });
    const proposal = turn.events.find((event) => event.type === "proposal").proposal;
    const response = await fetch(
      `${f.url}/api/ai/machines/1/proposals/${proposal.id}/apply`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.viewerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirm: true }),
      },
    );
    assert.equal(response.status, 403);
  });

  await t.test("the system prompt lists every host of the turn", async () => {
    await chat(f, {
      root: "/srv/app",
      message: "你好",
      autoRun: "read",
      hosts: [2, 3],
    });
    const prompt = f.modelRequests.at(-1).messages[0].content;
    assert.match(prompt, /Fixture 1 \(#1\) at 127\.0\.0\.1:\d+/);
    assert.match(prompt, /Fixture 2 \(#2\)/);
    assert.match(prompt, /primary/);
    assert.match(prompt, /extra/);
    assert.match(prompt, /ssh trusted/);
  });
});

test("host helpers", async (t) => {
  const {
    MAX_CHAT_HOSTS,
    conversationHostIds,
    hostLabel,
    mapLimit,
    resolveHost,
    resolveHosts,
    saveConversationHosts,
  } = await import("../dist/ai-hosts.js");
  const { openDb } = await import("../dist/db.js");

  const host = (id, name) => ({
    id,
    name,
    address: `10.0.0.${id}:22`,
    online: true,
    trusted: true,
    credentials: "ok",
  });
  const hosts = [host(1, "web-1"), host(2, "web-2"), host(3, "db-1")];
  const code = (fn) => {
    try {
      fn();
      return "";
    } catch (error) {
      return error.message;
    }
  };

  await t.test("resolveHost defaults to the primary host", () => {
    assert.equal(resolveHost(hosts, undefined).id, 1);
    assert.equal(resolveHost(hosts, "").id, 1);
    assert.equal(hostLabel(hosts[0]), "web-1 (#1)");
  });

  await t.test("resolveHost accepts an id, #id or name", () => {
    assert.equal(resolveHost(hosts, 2).id, 2);
    assert.equal(resolveHost(hosts, "3").id, 3);
    assert.equal(resolveHost(hosts, "#3").id, 3);
    assert.equal(resolveHost(hosts, "WEB-2").id, 2);
    assert.equal(resolveHost(hosts, " web-1 ").id, 1);
  });

  await t.test("resolveHost refuses unknown and ambiguous names", () => {
    assert.equal(code(() => resolveHost(hosts, 9)), "host_not_found");
    assert.equal(code(() => resolveHost(hosts, "web-9")), "host_not_found");
    assert.equal(code(() => resolveHost(hosts, {})), "host_not_found");
    const twins = [host(1, "web"), host(2, "web")];
    assert.equal(code(() => resolveHost(twins, "web")), "host_ambiguous");
    assert.equal(code(() => resolveHost([], undefined)), "host_not_configured");
  });

  await t.test("resolveHosts expands to every host", () => {
    assert.deepEqual(
      resolveHosts(hosts, undefined).map((item) => item.id),
      [1, 2, 3],
    );
    assert.deepEqual(
      resolveHosts(hosts, "all").map((item) => item.id),
      [1, 2, 3],
    );
    assert.deepEqual(
      resolveHosts(hosts, [3, 3, 1]).map((item) => item.id),
      [3, 1],
    );
    assert.deepEqual(resolveHosts(hosts, []).length, hosts.length);
    const many = Array.from({ length: MAX_CHAT_HOSTS + 1 }, (_, i) => i + 1);
    assert.equal(code(() => resolveHosts(hosts, many)), "too_many_hosts");
  });

  await t.test("mapLimit keeps the order and bounds the concurrency", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (value) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return value * 2;
    });
    assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
    assert.equal(peak, 2);
    assert.deepEqual(await mapLimit([], 3, async () => 1), []);
  });

  await t.test("host sets survive a missing, empty and oversized request", () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO ai_conversations(id,machine_id,user_id,title,root,model,created_at,updated_at) VALUES ('c1',1,1,'t','/','',0,0)",
    ).run();
    assert.deepEqual(saveConversationHosts(db, "c1", 1, [2, 3]), [2, 3]);
    // The primary host is never stored as an extra.
    assert.deepEqual(saveConversationHosts(db, "c1", 1, [1, 2]), [2]);
    // `undefined` keeps the stored set, an empty array clears it.
    assert.deepEqual(saveConversationHosts(db, "c1", 1, undefined), [2]);
    assert.deepEqual(conversationHostIds(db, "c1"), [2]);
    assert.deepEqual(saveConversationHosts(db, "c1", 1, []), []);
    assert.deepEqual(conversationHostIds(db, "c1"), []);
    // A request larger than the cap is trimmed, never rejected mid-run.
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(saveConversationHosts(db, "c1", 1, ids).length, MAX_CHAT_HOSTS - 1);
    // Replacing a set does not leave the old rows behind.
    assert.deepEqual(saveConversationHosts(db, "c1", 1, [4, 5]), [4, 5]);
    assert.deepEqual(conversationHostIds(db, "c1"), [4, 5]);
  });
});
