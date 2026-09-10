import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { Router } from "express";
import { z } from "zod";
import type { Db } from "./db.js";

export function normalizeTarget(raw: string): string | null {
  const value = raw.trim();
  if (isIP(value)) return value.toLowerCase();
  if (!value || value.length > 253 || /[\s/:@\\?#%]/.test(value)) return null;
  const host = domainToASCII(value).replace(/\.$/, "").toLowerCase();
  if (!host || host.length > 253 || /^[\d.]+$/.test(host)) return null;
  return host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? host : null;
}

export function parseLatency(output: string): number | null {
  // Match only an actual echo reply. Windows can exit successfully for unreachable replies.
  const match = output.match(/(?:[=<＝＜])\s*(\d+(?:[.,]\d+)?)\s*(?:ms|毫秒)/i);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

export type PingResult = { at: number; latencyMs: number | null; error: string | null };
export function probe(target: string, signal?: AbortSignal): Promise<PingResult> {
  if (normalizeTarget(target) !== target) return Promise.reject(new Error("bad_target"));
  const args = process.platform === "win32" ? ["-n", "1", "-w", "2000", target]
    : ["-n", "-c", "1", "-W", process.platform === "darwin" ? "2000" : "2", target];
  return new Promise((resolve) => {
    execFile("ping", args, { timeout: 4000, windowsHide: true, maxBuffer: 32 * 1024, signal,
      env: { ...process.env, LC_ALL: "C" } }, (err, stdout) => {
      const latencyMs = !err ? parseLatency(stdout) : null;
      resolve({ at: Date.now(), latencyMs, error: latencyMs != null ? null
        : (err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "ping_unavailable" : "timeout_or_unreachable" });
    });
  });
}

type Monitor = { id: number; target: string; intervalSec: number; enabled: number };
const TargetSchema = z.string().max(253).transform(normalizeTarget).refine((v) => v !== null);
const CreateSchema = z.object({ target: TargetSchema, intervalSec: z.number().int().min(5).max(300).default(5) });
const PatchSchema = z.object({ enabled: z.boolean() });

export function createPingService(db: Db, available: () => boolean, runProbe = probe) {
  const router = Router();
  const active = new Map<number, AbortController>();
  const due = new Map<number, number>();
  let singleActive = 0;
  let stopped = false;
  let lastPrune = 0;
  const insert = db.prepare("INSERT INTO ping_samples (monitor_id, at, latency_ms, error) VALUES (?, ?, ?, ?)");
  const scheduled = db.prepare("SELECT id, target, interval_sec as intervalSec, enabled FROM ping_monitors WHERE enabled = 1 ORDER BY id");
  const getMonitor = db.prepare("SELECT id, target, interval_sec as intervalSec, enabled FROM ping_monitors WHERE id = ?");
  const prune = db.prepare("DELETE FROM ping_samples WHERE id IN (SELECT id FROM ping_samples WHERE at < ? LIMIT 2000)");

  async function sample(m: Monitor) {
    const controller = new AbortController();
    active.set(m.id, controller);
    due.set(m.id, Date.now() + m.intervalSec * 1000);
    try {
      const result = await runProbe(m.target, controller.signal);
      if (!controller.signal.aborted && !stopped && available()) {
        const current = getMonitor.get(m.id) as Monitor | undefined;
        if (current?.enabled) insert.run(m.id, result.at, result.latencyMs, result.error);
      }
    } catch (e) { if (!controller.signal.aborted) console.error("[ping] probe failed", e); }
    finally { active.delete(m.id); }
  }

  const tick = () => {
    if (stopped || !available()) return;
    try {
      const now = Date.now();
      const monitors = (scheduled.all() as Monitor[]).sort((a, b) => (due.get(a.id) ?? 0) - (due.get(b.id) ?? 0));
      for (const m of monitors) {
        if (active.size + singleActive >= 4) break;
        if (!active.has(m.id) && (due.get(m.id) ?? 0) <= now) void sample(m);
      }
      if (now - lastPrune >= 60_000) {
        prune.run(now - 24 * 3600_000);
        lastPrune = now;
      }
    } catch (e) { console.error("[ping] scheduler failed", e); }
  };
  const timer = setInterval(tick, 1000);
  timer.unref();

  router.post("/", async (req, res, next) => {
    const body = z.object({ target: TargetSchema }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "bad_target" });
    if (active.size + singleActive >= 4) return res.status(429).json({ error: "ping_busy" });
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", cancel);
    singleActive++;
    try { res.json({ target: body.data.target, ...await runProbe(body.data.target!, controller.signal) }); }
    catch (e) { next(e); }
    finally { singleActive--; res.off("close", cancel); }
  });
  router.get("/monitors", (_req, res) => {
    res.json({ monitors: db.prepare(`SELECT m.id, m.target, m.interval_sec as intervalSec, m.enabled,
      s.at as lastAt, s.latency_ms as latencyMs, s.error FROM ping_monitors m
      LEFT JOIN ping_samples s ON s.id = (SELECT id FROM ping_samples WHERE monitor_id = m.id ORDER BY at DESC LIMIT 1)
      ORDER BY m.id`).all() });
  });
  router.post("/monitors", (req, res) => {
    const body = CreateSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "bad_target" });
    if (db.prepare("SELECT id FROM ping_monitors WHERE target = ?").get(body.data.target)) return res.status(409).json({ error: "monitor_exists" });
    if ((db.prepare("SELECT COUNT(*) as n FROM ping_monitors").get() as { n: number }).n >= 16) return res.status(409).json({ error: "monitor_limit" });
    const info = db.prepare("INSERT INTO ping_monitors (target, interval_sec, created_at) VALUES (?, ?, ?)").run(body.data.target, body.data.intervalSec, Date.now());
    res.status(201).json({ monitor: getMonitor.get(info.lastInsertRowid) });
    tick();
  });
  router.patch("/monitors/:id", (req, res) => {
    const body = PatchSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "bad_body" });
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || !getMonitor.get(id)) return res.status(404).json({ error: "not_found" });
    db.prepare("UPDATE ping_monitors SET enabled = ? WHERE id = ?").run(body.data.enabled ? 1 : 0, id);
    active.get(id)?.abort(); due.delete(id);
    res.json({ ok: true });
  });
  router.delete("/monitors/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || !getMonitor.get(id)) return res.status(404).json({ error: "not_found" });
    active.get(id)?.abort(); due.delete(id);
    db.prepare("DELETE FROM ping_monitors WHERE id = ?").run(id);
    res.json({ ok: true });
  });
  router.get("/monitors/:id/samples", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || !getMonitor.get(id)) return res.status(404).json({ error: "not_found" });
    const limit = z.coerce.number().int().min(1).max(720).safeParse(req.query.limit ?? 360);
    if (!limit.success) return res.status(400).json({ error: "bad_limit" });
    res.json({ samples: db.prepare("SELECT id, at, latency_ms as latencyMs, error FROM ping_samples WHERE monitor_id = ? ORDER BY at DESC LIMIT ?").all(id, limit.data).reverse() });
  });
  return { router, tick, stop() { stopped = true; clearInterval(timer); for (const ctrl of active.values()) ctrl.abort(); } };
}
