import type { Db } from "./db.js";
import { runCommand } from "./files.js";
import { WorkspaceError } from "./ssh.js";

/**
 * Resource snapshot for the SSH workspace sidebar.
 *
 * The probe is one fixed POSIX shell snippet (no interpolation, so nothing from the
 * request can reach the remote shell) whose output is a flat list of tagged lines:
 * `K` key/value, `C` a `/proc/stat` cpu sample, `M` meminfo, `D` a `df -Pk` row,
 * `P` a process row, `N` network totals. Everything is parsed defensively: a missing
 * section (BSD, busybox, trimmed output) simply leaves the matching fields null.
 */
export const STATS_SCRIPT = [
  "hostname 2>/dev/null | head -n 1 | sed 's/^/K host /'",
  "uname -sr 2>/dev/null | head -n 1 | sed 's/^/K kernel /'",
  "cut -d' ' -f1 /proc/uptime 2>/dev/null | sed 's/^/K uptime /'",
  "cut -d' ' -f1-3 /proc/loadavg 2>/dev/null | sed 's/^/K load /'",
  "(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null) 2>/dev/null | head -n 1 | sed 's/^/K cpus /'",
  "grep '^cpu ' /proc/stat 2>/dev/null | sed 's/^/C a /'",
  // Takes a second sample so the cpu figure is "now" instead of "since boot".
  "sleep 0.3 2>/dev/null",
  "grep '^cpu ' /proc/stat 2>/dev/null | sed 's/^/C b /'",
  "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null | sed 's/^/M /'",
  // `[ -d ]` drops the file bind mounts containers create (/etc/hosts, resolv.conf…),
  // which `df` reports as if they were filesystems.
  "df -Pk 2>/dev/null | tail -n +2 | while read -r fs blocks used avail cap mount rest; do d=\"$mount\"; [ -n \"$rest\" ] && d=\"$mount $rest\"; [ -d \"$d\" ] && printf 'D %s %s %s %s %s %s\\n' \"$fs\" \"$blocks\" \"$used\" \"$avail\" \"$cap\" \"$d\"; done",
  // `awk` drops the probe's own helper processes; otherwise an idle machine reports
  // sed/head/ps as its busiest processes.
  // Capture first, filter afterwards: only `ps`, `head` and the command substitution
  // shell exist while the sample is taken, so a real `sleep`/`tail` job stays visible.
  "p=$(ps -eo pid=,comm=,pcpu=,pmem=,rss= --sort=-pcpu 2>/dev/null | head -n 12)",
  "[ -n \"$p\" ] && printf '%s\\n' \"$p\" | awk '$3+0 == 0 && $4+0 == 0 && $2 ~ /^(ps|head|sh|dash|bash|busybox)$/ { next } { print }' | head -n 8 | sed 's/^ *//;s/^/P /'",
  "awk -F'[: ]+' 'NR>2 && $2 != \"\" && $2 != \"lo\" { rx += $3; tx += $11 } END { if (rx > 0) printf \"K net %.0f %.0f\\n\", rx, tx }' /proc/net/dev 2>/dev/null",
].join("\n");

export type DiskUsage = {
  filesystem: string;
  mount: string;
  totalKb: number;
  usedKb: number;
  availKb: number;
  usePercent: number;
};

export type ProcessUsage = {
  pid: number;
  command: string;
  cpuPercent: number;
  memPercent: number;
  rssKb: number;
};

export type CpuStats = {
  cores: number;
  percent: number | null;
  /** `sample` = measured over the probe window, `boot` = average since boot. */
  source: "sample" | "boot" | null;
  userPercent: number | null;
  systemPercent: number | null;
  iowaitPercent: number | null;
  idlePercent: number | null;
};

export type MemoryStats = {
  totalKb: number;
  usedKb: number;
  availableKb: number;
  cachedKb: number;
  buffersKb: number;
  percent: number;
  swapTotalKb: number;
  swapUsedKb: number;
  swapPercent: number;
};

export type SystemStats = {
  at: number;
  hostname: string | null;
  kernel: string | null;
  uptimeSeconds: number | null;
  load: { one: number | null; five: number | null; fifteen: number | null };
  cpu: CpuStats;
  memory: MemoryStats | null;
  disks: DiskUsage[];
  processes: ProcessUsage[];
  network: { rxBytes: number; txBytes: number } | null;
};

/** Synthetic filesystems and container layers are not what an operator means by "disk". */
const PSEUDO_FILESYSTEMS = new Set([
  "tmpfs",
  "devtmpfs",
  "devfs",
  "ramfs",
  "shm",
  "squashfs",
  "cgroup",
  "cgroup2",
  "proc",
  "sysfs",
  "devpts",
  "mqueue",
  "hugetlbfs",
  "debugfs",
  "tracefs",
  "binfmt_misc",
  "securityfs",
  "pstore",
  "configfs",
  "fusectl",
  "nsfs",
  "autofs",
  "rpc_pipefs",
  "fuse.gvfsd-fuse",
]);

export function isRealFilesystem(filesystem: string, mount: string) {
  if (PSEUDO_FILESYSTEMS.has(filesystem)) return false;
  if (/^\/(dev|proc|sys|run|snap)(\/|$)/.test(mount)) return false;
  // Bind mounts created by container runtimes: one overlay entry per container and
  // one entry per `/etc/hosts` style file would otherwise flood the list.
  if (mount.includes("/overlay2/")) return false;
  if (
    /^\/var\/lib\/(docker|kubelet|containerd|containers)\//.test(mount) ||
    /^\/(run|var\/run)\/(containerd|docker)\//.test(mount)
  )
    return false;
  return true;
}

/**
 * Bind mounts make the same filesystem appear under several paths (a docker volume at
 * `/config`, a container's `/etc/hosts` file). Only drop the inner path, never a second
 * disk: two distinct mounts are not ancestors of each other.
 */
function isAncestorMount(parent: string, child: string) {
  if (parent === child) return false;
  const base = parent.length > 1 && parent.endsWith("/") ? parent.slice(0, -1) : parent;
  return base === "/" ? true : child.startsWith(`${base}/`);
}

export function dedupeMounts(disks: DiskUsage[]): DiskUsage[] {
  return disks.filter((disk, index) =>
    !disks.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      if (other.totalKb !== disk.totalKb || other.usedKb !== disk.usedKb)
        return false;
      if (!isAncestorMount(other.mount, disk.mount)) return false;
      if (other.mount.length !== disk.mount.length)
        return other.mount.length < disk.mount.length;
      return otherIndex < index;
    }),
  );
}

function toNumber(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value.trim().replace(/%$/, ""));
  return Number.isFinite(n) ? n : null;
}

function percentOf(used: number, total: number) {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

/** `/proc/stat` cpu line -> [user, nice, system, idle, iowait, irq, softirq, steal]. */
export function parseCpuSample(line: string): number[] | null {
  const parts = line.replace(/^(?:C )?[ab] /, "").trim().split(/\s+/);
  if (parts[0] !== "cpu" || parts.length < 5) return null;
  const values = parts.slice(1).map((v) => Number(v));
  if (values.some((v) => !Number.isFinite(v) || v < 0)) return null;
  return values;
}

function cpuBreakdown(counts: number[], total: number) {
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0] =
    counts;
  const pct = (v: number) => (total > 0 ? Math.max(0, Math.min(100, (v / total) * 100)) : null);
  return {
    userPercent: pct(user + nice),
    systemPercent: pct(system + irq + softirq),
    iowaitPercent: pct(iowait),
    idlePercent: pct(idle + iowait),
  };
}

export function computeCpu(
  previous: number[] | null,
  current: number[] | null,
): CpuStats {
  const empty: CpuStats = {
    cores: 0,
    percent: null,
    source: null,
    userPercent: null,
    systemPercent: null,
    iowaitPercent: null,
    idlePercent: null,
  };
  if (!current) return empty;
  if (previous && previous.length === current.length) {
    const delta = current.map((v, i) => Math.max(0, v - (previous[i] ?? 0)));
    const total = delta.reduce((a, b) => a + b, 0);
    // A too small window means the two samples were taken back to back (some
    // systems reject fractional `sleep`), so the delta would be noise.
    if (total >= 4) {
      const idle = (delta[3] ?? 0) + (delta[4] ?? 0);
      return {
        cores: 0,
        percent: percentOf(total - idle, total),
        source: "sample",
        ...cpuBreakdown(delta, total),
      };
    }
  }
  const total = current.reduce((a, b) => a + b, 0);
  if (total <= 0) return empty;
  const idle = (current[3] ?? 0) + (current[4] ?? 0);
  return {
    cores: 0,
    percent: percentOf(total - idle, total),
    source: "boot",
    ...cpuBreakdown(current, total),
  };
}

export function parseMeminfo(entries: Map<string, number>): MemoryStats | null {
  const total = entries.get("MemTotal");
  if (!total || total <= 0) return null;
  const available =
    entries.get("MemAvailable") ??
    (entries.get("MemFree") ?? 0) +
      (entries.get("Buffers") ?? 0) +
      (entries.get("Cached") ?? 0);
  const used = Math.max(0, total - available);
  const swapTotal = entries.get("SwapTotal") ?? 0;
  const swapUsed = Math.max(0, swapTotal - (entries.get("SwapFree") ?? 0));
  return {
    totalKb: total,
    usedKb: used,
    availableKb: Math.max(0, available),
    cachedKb: entries.get("Cached") ?? 0,
    buffersKb: entries.get("Buffers") ?? 0,
    percent: percentOf(used, total),
    swapTotalKb: swapTotal,
    swapUsedKb: swapUsed,
    swapPercent: swapTotal > 0 ? percentOf(swapUsed, swapTotal) : 0,
  };
}

/**
 * Keep the filesystems with the most data on them, plus any that are nearly full
 * (a 95% `/boot` matters even when it is tiny).
 */
export function selectDisks(disks: DiskUsage[], max = 12): DiskUsage[] {
  const bySize = [...disks].sort((a, b) => b.usedKb - a.usedKb);
  const picked = bySize.slice(0, Math.max(1, max));
  for (const disk of disks)
    if (disk.usePercent >= 85 && !picked.includes(disk)) picked.push(disk);
  return picked.sort((a, b) => b.usedKb - a.usedKb);
}

const PROCESS_RE = /^(\d+)\s+(.+?)\s+([\d.]+)\s+([\d.]+)\s+(\d+)$/;
// procps `ps aux`: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
const PS_AUX_RE =
  /^\S+\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+\d+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/;

export function parseProcesses(lines: string[]): ProcessUsage[] {
  const out: ProcessUsage[] = [];
  for (const line of lines) {
    const tagged = PROCESS_RE.exec(line.replace(/^P /, "").trim());
    if (tagged) {
      const pid = Number(tagged[1]);
      const rssKb = Number(tagged[5]);
      if (!Number.isFinite(pid) || !Number.isFinite(rssKb)) continue;
      out.push({
        pid,
        command: tagged[2].trim(),
        cpuPercent: Number(tagged[3]),
        memPercent: Number(tagged[4]),
        rssKb,
      });
      continue;
    }
    if (!line.startsWith("P ")) continue;
    const aux = PS_AUX_RE.exec(line.slice(2).trim());
    if (!aux) continue;
    const pid = Number(aux[1]);
    const rssKb = Number(aux[4]);
    if (!Number.isFinite(pid) || !Number.isFinite(rssKb)) continue;
    out.push({
      pid,
      command: aux[5].trim().split(/\s+/)[0],
      cpuPercent: Number(aux[2]),
      memPercent: Number(aux[3]),
      rssKb,
    });
  }
  return out
    .filter((p) => p.rssKb > 0)
    .sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssKb - a.rssKb)
    .slice(0, 6);
}

export function parseSystemStats(text: string, now = Date.now()): SystemStats {
  const keys = new Map<string, string>();
  const meminfo = new Map<string, number>();
  const disks: DiskUsage[] = [];
  const processLines: string[] = [];
  let cpuA: number[] | null = null;
  let cpuB: number[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("K ")) {
      const sep = line.indexOf(" ", 2);
      if (sep < 0) continue;
      keys.set(line.slice(2, sep).trim(), line.slice(sep + 1).trim());
      continue;
    }
    if (line.startsWith("C a ")) {
      cpuA = parseCpuSample(line);
      continue;
    }
    if (line.startsWith("C b ")) {
      cpuB = parseCpuSample(line);
      continue;
    }
    if (line.startsWith("M ")) {
      const match = /^([A-Za-z_()]+):\s*(\d+)/.exec(line.slice(2));
      if (match) meminfo.set(match[1], Number(match[2]));
      continue;
    }
    if (line.startsWith("D ")) {
      const parts = line.slice(2).trim().split(/\s+/);
      if (parts.length < 6) continue;
      // Ignore the header that some df implementations still emit.
      const totalKb = toNumber(parts[1]);
      const usedKb = toNumber(parts[2]);
      const availKb = toNumber(parts[3]);
      if (totalKb === null || usedKb === null) continue;
      const mount = parts.slice(5).join(" ");
      if (!isRealFilesystem(parts[0], mount)) continue;
      disks.push({
        filesystem: parts[0],
        mount,
        totalKb,
        usedKb,
        availKb: availKb ?? 0,
        usePercent:
          toNumber(parts[4]) ??
          percentOf(usedKb, usedKb + Math.max(0, availKb ?? 0)),
      });
      continue;
    }
    if (line.startsWith("P ")) processLines.push(line);
  }
  const cpu = computeCpu(cpuA, cpuB);
  cpu.cores = Math.max(0, Math.round(toNumber(keys.get("cpus")) ?? 0));
  const net = keys.get("net")?.trim().split(/\s+/) ?? [];
  const netRx = toNumber(net[0]);
  const netTx = toNumber(net[1]);
  return {
    at: now,
    hostname: keys.get("host") || null,
    kernel: keys.get("kernel") || null,
    uptimeSeconds: toNumber(keys.get("uptime")),
    load: {
      one: toNumber(keys.get("load")?.split(/\s+/)[0]),
      five: toNumber(keys.get("load")?.split(/\s+/)[1]),
      fifteen: toNumber(keys.get("load")?.split(/\s+/)[2]),
    },
    cpu,
    memory: parseMeminfo(meminfo),
    disks: selectDisks(dedupeMounts(disks)),
    processes: parseProcesses(processLines),
    network:
      netRx === null && netTx === null
        ? null
        : { rxBytes: netRx ?? 0, txBytes: netTx ?? 0 },
  };
}

/** How long a snapshot may be reused; the panel polls on a longer interval than this. */
export const STATS_TTL_MS = 5000;

const cache = new Map<number, { at: number; value: SystemStats }>();
const inflight = new Map<number, Promise<SystemStats>>();
let active = 0;

export function cachedStats(machineId: number): SystemStats | null {
  const hit = cache.get(machineId);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.value;
  return null;
}

/**
 * Collect a snapshot, reusing a recent one and coalescing concurrent requests so a
 * dashboard with several open tabs cannot open an SSH connection per tab.
 */
export async function collectSystemStats(
  db: Db,
  machineId: number,
  secret: string,
  signal?: AbortSignal,
): Promise<{ stats: SystemStats; cached: boolean }> {
  const hit = cachedStats(machineId);
  if (hit) return { stats: hit, cached: true };
  const pending = inflight.get(machineId);
  if (pending) return { stats: await pending, cached: true };
  if (active >= 4) throw new WorkspaceError(429, "workspace_busy");
  active += 1;
  const task = (async () => {
    const result = await runCommand(
      db,
      machineId,
      secret,
      "/",
      STATS_SCRIPT,
      signal,
    );
    const stats = parseSystemStats(result.output);
    if (cache.size > 64) cache.clear();
    cache.set(machineId, { at: Date.now(), value: stats });
    return stats;
  })();
  inflight.set(machineId, task);
  try {
    return { stats: await task, cached: false };
  } finally {
    inflight.delete(machineId);
    active -= 1;
  }
}
