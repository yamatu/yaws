import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { harness } from "./fixture.mjs";

test(
  "machine-bound Ping, SSH identity, SFTP files, shortcuts and AI approvals",
  { timeout: 90000 },
  async () => {
    const f = await harness();
    const request = async (path, method = "GET", body, token = f.token) => {
      const response = await fetch(f.url + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    try {
      assert.equal(
        (await request("/api/ping/monitors", "GET", undefined, f.viewerToken))
          .status,
        403,
      );
      const single = await request("/api/ping", "POST", {
        machineId: 2,
        target: "google.com",
      });
      assert.equal(single.body.latencyMs, 20);
      assert.equal(single.body.machineId, 2);
      assert.equal(
        (
          await request("/api/ping", "POST", {
            machineId: 3,
            target: "google.com",
          })
        ).body.error,
        "agent_upgrade_required",
      );
      const monitor = await request("/api/ping/monitors", "POST", {
        machineId: 2,
        target: "google.com",
      });
      assert.equal(monitor.status, 201);
      assert.equal(
        (
          await request("/api/ping/monitors", "POST", {
            machineId: 1,
            target: "google.com",
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await request("/api/ping/monitors", "POST", {
            machineId: 2,
            target: "google.com",
          })
        ).status,
        409,
      );
      const base = "/api/machines/1/workspace";
      assert.equal(
        (await request(base + "/file?path=/srv/app/config.json")).body.error,
        "ssh_host_untrusted",
      );
      const inspected = await request(base + "/host-key/inspect", "POST");
      assert.equal(inspected.status, 200);
      assert.equal(
        (await request(base + "/host-key", "PUT", inspected.body)).status,
        200,
      );
      const key = await request(base + "/host-key");
      assert.match(key.body.fingerprint, /^SHA256:/);
      await request(base + "/host-key", "PUT", {
        address: key.body.address,
        fingerprint: "SHA256:" + "A".repeat(43),
      });
      assert.equal(
        (await request(base + "/file?path=/srv/app/config.json")).body.error,
        "ssh_host_key_changed",
      );
      await request(base + "/host-key", "PUT", inspected.body);
      const products = await request(base + "/products");
      assert.equal(products.body.home, "/srv/app");
      assert.ok(products.body.products.some((p) => p.name === "Nginx"));
      const file = await request(base + "/file?path=/srv/app/config.json");
      assert.equal(file.body.content, '{"enabled":false}\n');
      assert.equal(
        (await request(base + "/file?path=/srv/app/binary.dat")).status,
        415,
      );
      const saved = await request(base + "/file", "PUT", {
        path: "/srv/app/config.json",
        content: '{"enabled":false,"v":2}\n',
        revision: file.body.revision,
      });
      assert.equal(saved.status, 200);
      assert.ok(f.files.has(saved.body.backup));
      assert.equal(
        (
          await request(base + "/file", "PUT", {
            path: "/srv/app/config.json",
            content: "bad",
            revision: file.body.revision,
          })
        ).status,
        409,
      );
      const upload = await fetch(
        f.url + base + "/upload?path=/srv/app/upload.txt",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.token}`,
            "content-type": "application/octet-stream",
          },
          body: Buffer.from("uploaded"),
        },
      );
      assert.equal(upload.status, 200);
      assert.equal(f.files.get("/srv/app/upload.txt").toString(), "uploaded");
      const shortcut = await request(base + "/shortcuts", "POST", {
        name: "Health",
        command: "uptime",
      });
      assert.equal(shortcut.status, 201);
      await request(base + `/shortcuts/${shortcut.body.id}`, "PUT", {
        name: "Health2",
        command: "pwd",
      });
      assert.equal(
        (await request(base + "/shortcuts")).body.shortcuts[0].command,
        "pwd",
      );
      for (const protocol of ["chat", "responses"]) {
        const settings = {
          baseUrl: f.modelUrl,
          model: "fixture-model",
          protocol,
          reasoning: protocol === "chat" ? "high" : "max",
          apiKey: "fixture-key",
          allowPrivate: true,
        };
        assert.equal(
          (await request("/api/ai/settings", "PUT", settings)).status,
          200,
        );
        const publicSettings = await request("/api/ai/settings");
        assert.equal(publicSettings.body.apiKey, undefined);
        assert.equal(publicSettings.body.hasKey, true);
        const before = f.files.get("/srv/app/config.json").toString();
        const run = await request("/api/ai/machines/1/run", "POST", {
          root: "/srv/app",
          prompt: "Enable the config and propose validation.",
        });
        assert.equal(run.status, 200, JSON.stringify(run.body));
        assert.equal(run.body.proposals.length, 2);
        assert.equal(f.files.get("/srv/app/config.json").toString(), before);
        assert.equal(f.commands.length, protocol === "chat" ? 0 : 1);
        const proposal = run.body.proposals.find((p) => p.kind === "file");
        const recovered = await request(
          `/api/ai/machines/1/runs/${run.body.runId}`,
        );
        assert.equal(recovered.body.proposals.length, 2);
        assert.equal(
          (
            await request(
              `/api/ai/machines/2/proposals/${proposal.id}/apply`,
              "POST",
              { confirm: true },
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await request(
              `/api/ai/machines/1/proposals/${proposal.id}/apply`,
              "POST",
              {},
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await request(
              `/api/ai/machines/1/proposals/${proposal.id}/apply`,
              "POST",
              { confirm: true },
            )
          ).status,
          200,
        );
        assert.equal(
          f.files.get("/srv/app/config.json").toString(),
          '{"enabled":true}\n',
        );
        assert.equal(
          (
            await request(
              `/api/ai/machines/1/proposals/${proposal.id}/apply`,
              "POST",
              { confirm: true },
            )
          ).status,
          409,
        );
        const command = run.body.proposals.find((p) => p.kind === "command");
        assert.equal(
          (
            await request(
              `/api/ai/machines/1/proposals/${command.id}/apply`,
              "POST",
              { confirm: true },
            )
          ).status,
          200,
        );
        const modelRequest = f.modelRequests.find((r) =>
          protocol === "chat"
            ? r.reasoning_effort === "high"
            : r.reasoning?.effort === "max",
        );
        assert.ok(modelRequest);
      }
      const outside = await request("/api/ai/machines/1/run", "POST", {
        root: "/etc/nginx",
        prompt: "Inspect selected directory.",
      });
      assert.equal(outside.status, 200);
      assert.equal(
        outside.body.proposals.filter((p) => p.kind === "file").length,
        0,
      );
      const commandCount = f.commands.length;
      assert.equal(commandCount, 2);
      const ws = new WebSocket(
        f.url.replace("http", "ws") + "/ws/ssh",
        ["yaws", `bearer.${f.token}`],
        { headers: { origin: f.url } },
      );
      await new Promise((resolve, reject) => {
        ws.on("error", reject);
        ws.on("open", () =>
          ws.send(
            JSON.stringify({
              type: "connect",
              machineId: 1,
              cols: 100,
              rows: 30,
            }),
          ),
        );
        ws.on("message", (raw) => {
          const m = JSON.parse(raw);
          if (m.type === "ready") {
            ws.send(
              JSON.stringify({
                type: "input",
                dataB64: Buffer.from("hello").toString("base64"),
              }),
            );
          }
          if (
            m.type === "output" &&
            Buffer.from(m.dataB64, "base64").toString().includes("hello")
          )
            resolve();
          if (m.type === "error") reject(new Error(m.error));
        });
      });
      f.hub.closeUser(1);
      await new Promise((resolve) => ws.on("close", resolve));
      assert.equal(
        f.db
          .prepare(
            "SELECT COUNT(*) as n FROM ssh_sessions WHERE ended_at IS NULL",
          )
          .get().n,
        0,
      );
      const denied = new WebSocket(
        f.url.replace("http", "ws") + "/ws/ssh",
        ["yaws", `bearer.${f.token}`],
        { headers: { origin: "https://evil.invalid" } },
      );
      await new Promise((resolve, reject) => {
        denied.once("error", resolve);
        denied.once("open", () => reject(new Error("origin bypass")));
      });
    } finally {
      await f.close();
    }
  },
);
