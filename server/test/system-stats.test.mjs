import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCpu,
  dedupeMounts,
  isRealFilesystem,
  parseCpuSample,
  parseMeminfo,
  parseProcesses,
  parseSystemStats,
  selectDisks,
  STATS_SCRIPT,
} from "../src/system-stats.js";

const SAMPLE = [
  "K host web-1",
  "K kernel Linux 6.1.0-13-amd64",
  "K uptime 123456.78",
  "K load 0.52 0.41 0.35",
  "K cpus 4",
  "C a cpu  1000 20 300 50000 50 0 40 5 0 0",
  "C b cpu  1030 20 320 50100 52 0 41 5 0 0",
  "M MemTotal:       16333780 kB",
  "M MemFree:          230000 kB",
  "M MemAvailable:    8000000 kB",
  "M Buffers:          120000 kB",
  "M Cached:          4500000 kB",
  "M SwapTotal:       2097148 kB",
  "M SwapFree:        1572860 kB",
  "D /dev/sda1 41152736 20152320 18896416 52% /",
  "D /dev/sdb1 20511312 19456000 1055312 95% /data",
  "D tmpfs 812340 0 812340 0% /run/user/0",
  "D /dev/sdc1 102400 102400 0 100% /boot",
  "D overlay 41152736 20152320 18896416 52% /var/lib/docker/overlay2/abc/merged",
  "D devtmpfs 4096 0 4096 0% /dev",
  "P 991 nginx 12.3 1.2 45678",
  "P 1234 node 45.6 23.4 1234567",
  "P 2 kthreadd 0.0 0.0 0",
  "K net 123456789 987654321",
  "",
].join("\n");

test("system stats probe is a fixed shell snippet without interpolation", () => {
  assert.ok(STATS_SCRIPT.includes("/proc/meminfo"));
  assert.ok(STATS_SCRIPT.includes("df -Pk"));
  assert.ok(!STATS_SCRIPT.includes("${"), "no request data may reach the probe");
  assert.ok(!STATS_SCRIPT.includes("'\\'"), "no escaping needed");
});

test("cpu sample parsing tolerates markers and rejects junk", () => {
  assert.deepEqual(parseCpuSample("C b cpu  1030 20 320 50100 52 0 41 5 0 0"), [
    1030, 20, 320, 50100, 52, 0, 41, 5, 0, 0,
  ]);
  assert.deepEqual(parseCpuSample("cpu  1 2 3 4"), [1, 2, 3, 4]);
  assert.equal(parseCpuSample("cpu  1 2"), null);
  assert.equal(parseCpuSample("cpu  a b c d"), null);
  assert.equal(parseCpuSample(""), null);
});

test("cpu usage is measured between the two samples", () => {
  const stats = computeCpu(
    [1000, 20, 300, 50000, 50, 0, 40, 5],
    [1030, 20, 320, 50100, 52, 0, 41, 5],
  );
  assert.equal(stats.source, "sample");
  // delta total 153, idle 102 -> 33.33% busy
  assert.equal(Math.round(stats.percent), 33);
  assert.equal(Math.round(stats.userPercent), 20);
  assert.equal(Math.round(stats.systemPercent), 14);
  assert.equal(Math.round(stats.iowaitPercent), 1);
  assert.equal(Math.round(stats.idlePercent), 67);
});

test("cpu falls back to the average since boot when the window is unusable", () => {
  const identical = computeCpu(
    [100, 0, 50, 1000, 0, 0, 0, 0],
    [100, 0, 50, 1000, 0, 0, 0, 0],
  );
  assert.equal(identical.source, "boot");
  assert.equal(Math.round(identical.percent), 13);
  const single = computeCpu(null, [100, 0, 50, 1000, 0, 0, 0, 0]);
  assert.equal(single.source, "boot");
  const none = computeCpu(null, null);
  assert.equal(none.percent, null);
  assert.equal(none.source, null);
  const zero = computeCpu(null, [0, 0, 0, 0]);
  assert.equal(zero.percent, null);
});

test("memory maths uses MemAvailable with a MemFree fallback", () => {
  const withAvailable = parseMeminfo(
    new Map([
      ["MemTotal", 16333780],
      ["MemFree", 230000],
      ["MemAvailable", 8000000],
      ["Buffers", 120000],
      ["Cached", 4500000],
      ["SwapTotal", 2097148],
      ["SwapFree", 1572860],
    ]),
  );
  assert.equal(withAvailable.totalKb, 16333780);
  assert.equal(withAvailable.usedKb, 8333780);
  assert.equal(Math.round(withAvailable.percent), 51);
  assert.equal(withAvailable.swapUsedKb, 524288);
  assert.equal(Math.round(withAvailable.swapPercent), 25);

  const fallback = parseMeminfo(
    new Map([
      ["MemTotal", 1000],
      ["MemFree", 100],
      ["Buffers", 50],
      ["Cached", 200],
    ]),
  );
  assert.equal(fallback.availableKb, 350);
  assert.equal(fallback.usedKb, 650);
  assert.equal(fallback.swapTotalKb, 0);
  assert.equal(fallback.swapPercent, 0);
  assert.equal(parseMeminfo(new Map([["MemFree", 10]])), null);
  assert.equal(parseMeminfo(new Map([["MemTotal", 0]])), null);
});

test("pseudo filesystems and container layers never show up as disks", () => {
  assert.equal(isRealFilesystem("tmpfs", "/run/user/0"), false);
  assert.equal(isRealFilesystem("devtmpfs", "/dev"), false);
  assert.equal(isRealFilesystem("overlay", "/var/lib/docker/overlay2/a/merged"), false);
  assert.equal(isRealFilesystem("/dev/sda1", "/var/lib/docker/containers/abc/hosts"), false);
  assert.equal(isRealFilesystem("/dev/sda1", "/var/lib/kubelet/pods/x/etc-hosts"), false);
  assert.equal(isRealFilesystem("/dev/sda1", "/run/containerd/io.containerd.runtime/x"), false);
  assert.equal(isRealFilesystem("ext4", "/"), true);
  assert.equal(isRealFilesystem("ext4", "/data"), true);
  assert.equal(isRealFilesystem("xfs", "/var/lib/docker"), true, "a docker data disk stays visible");
  assert.equal(isRealFilesystem("overlay", "/"), true, "container root stays visible");
});

test("the same device mounted several times is listed once", () => {
  const disk = (mount, filesystem = "/dev/sde") => ({
    filesystem,
    mount,
    totalKb: 1000,
    usedKb: 500,
    availKb: 500,
    usePercent: 50,
  });
  assert.deepEqual(
    dedupeMounts([
      disk("/etc/resolv.conf"),
      disk("/etc/hostname"),
      disk("/etc/hosts"),
      disk("/config", "/dev/sdf"),
      disk("/data", "/dev/sdb"),
      disk("/", "/dev/sda1"),
    ]).map((d) => d.mount),
    ["/"],
  );
});

test("two disks with identical usage are both listed", () => {
  const disk = (mount, filesystem, usedKb) => ({
    filesystem,
    mount,
    totalKb: 1000,
    usedKb,
    availKb: 1000 - usedKb,
    usePercent: 0,
  });
  assert.deepEqual(
    dedupeMounts([
      disk("/data1", "/dev/sdb", 0),
      disk("/data2", "/dev/sdc", 0),
      disk("/", "/dev/sda1", 400),
    ]).map((d) => d.mount),
    ["/data1", "/data2", "/"],
  );
});

test("disk selection keeps the biggest filesystems plus nearly full ones", () => {
  const disks = [
    { filesystem: "a", mount: "/", totalKb: 100, usedKb: 100, availKb: 0, usePercent: 100 },
    { filesystem: "b", mount: "/data", totalKb: 1000, usedKb: 900, availKb: 100, usePercent: 90 },
    { filesystem: "c", mount: "/big", totalKb: 100000, usedKb: 10000, availKb: 90000, usePercent: 10 },
  ];
  assert.deepEqual(
    selectDisks(disks, 1).map((d) => d.mount),
    ["/big", "/data", "/"],
  );
  assert.deepEqual(
    selectDisks(disks, 12).map((d) => d.mount),
    ["/big", "/data", "/"],
  );
});

test("process list handles procps short and ps aux formats", () => {
  const rows = parseProcesses([
    "P 1234 node 45.6 23.4 1234567",
    "P 991 nginx: worker 12.3 1.2 45678",
    "P 2 kthreadd 0.0 0.0 0",
    "P root 4321 9.5 2.5 456789 78901 ?  Ss  Jan01  1:23 /usr/sbin/nginx -g daemon off;",
    "not a process line",
  ]);
  assert.deepEqual(
    rows.map((p) => [p.pid, p.command, p.cpuPercent]),
    [
      [1234, "node", 45.6],
      [4321, "/usr/sbin/nginx", 9.5],
      [991, "nginx: worker", 12.3],
    ].sort((a, b) => b[2] - a[2]),
  );
  assert.equal(rows.length, 3);
  assert.ok(!rows.some((p) => p.pid === 2), "zero-rss kernel threads are dropped");
  const many = parseProcesses(
    Array.from({ length: 12 }, (_, i) => `P ${i + 1} proc${i} ${i}.0 1.0 1000`),
  );
  assert.equal(many.length, 6);
  assert.equal(many[0].cpuPercent, 11);
});

test("parser reads a full snapshot and ignores noise", () => {
  const stats = parseSystemStats(SAMPLE, 1700000000000);
  assert.equal(stats.at, 1700000000000);
  assert.equal(stats.hostname, "web-1");
  assert.equal(stats.kernel, "Linux 6.1.0-13-amd64");
  assert.equal(stats.uptimeSeconds, 123456.78);
  assert.deepEqual(stats.load, { one: 0.52, five: 0.41, fifteen: 0.35 });
  assert.equal(stats.cpu.cores, 4);
  assert.equal(stats.cpu.source, "sample");
  assert.equal(Math.round(stats.cpu.percent), 33);
  assert.equal(Math.round(stats.memory.percent), 51);
  assert.deepEqual(
    stats.disks.map((d) => [d.mount, d.usePercent]),
    [
      ["/", 52],
      ["/data", 95],
      ["/boot", 100],
    ],
  );
  assert.deepEqual(
    stats.processes.map((p) => p.command),
    ["node", "nginx"],
  );
  assert.deepEqual(stats.network, { rxBytes: 123456789, txBytes: 987654321 });
});

test("empty, garbled or windows-terminated output degrades instead of throwing", () => {
  const empty = parseSystemStats("");
  assert.equal(empty.hostname, null);
  assert.equal(empty.cpu.percent, null);
  assert.equal(empty.cpu.cores, 0);
  assert.deepEqual(empty.disks, []);
  assert.deepEqual(empty.processes, []);
  assert.equal(empty.memory, null);
  assert.equal(empty.network, null);

  const garbled = parseSystemStats(
    "bash: df: command not found\nD Filesystem 1024-blocks Used Available Capacity Mounted on\nK\r\nP x y\r\n",
  );
  assert.deepEqual(garbled.disks, []);
  assert.deepEqual(garbled.processes, []);

  const crlf = parseSystemStats("K host web-2\r\nK cpus 2\r\nD /dev/sda1 100 50 50 50% /mnt\r\n");
  assert.equal(crlf.hostname, "web-2");
  assert.equal(crlf.cpu.cores, 2);
  assert.deepEqual(crlf.disks.map((d) => d.usePercent), [50]);
  assert.equal(crlf.disks[0].mount, "/mnt");
});

test("disk rows without a capacity column fall back to a computed percentage", () => {
  const stats = parseSystemStats("D 10.0.0.1:/export 1000 250 750 - /mnt/nfs\n");
  assert.deepEqual(stats.disks, [
    {
      filesystem: "10.0.0.1:/export",
      mount: "/mnt/nfs",
      totalKb: 1000,
      usedKb: 250,
      availKb: 750,
      usePercent: 25,
    },
  ]);
});
