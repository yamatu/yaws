/**
 * Command classification for the AI chat assistant.
 *
 * The assistant is allowed to inspect a server on its own, but anything that changes
 * state has to be approved by the operator first. Classification is deliberately
 * conservative: a command we do not recognise counts as a mutation.
 */
export type CommandClass = "read" | "write" | "dangerous";
export type AutoRunMode = "off" | "read" | "all";

/** Filters that only print information. Interpreter-ish tools are intentionally absent. */
export const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "tac", "nl", "column",
  "grep", "egrep", "fgrep", "rg", "zgrep", "zcat", "sort", "uniq", "cut", "tr",
  "diff", "cmp", "jq", "yq", "iconv", "md5sum", "sha1sum", "sha256sum", "sha512sum", "cksum", "base64",
  "xxd", "od", "strings", "stat", "file", "readlink", "realpath", "basename",
  "dirname", "which", "type", "pwd", "tree", "du", "df", "lsblk", "blkid", "lsof",
  "fuser", "mount", "findmnt", "getent", "nproc", "lscpu", "lsmod", "lsusb", "lspci",
  "ps", "pgrep", "pstree", "top", "free", "uptime", "vmstat", "iostat", "mpstat",
  "sar", "who", "w", "id", "groups", "last", "lastlog", "uname", "hostname",
  "hostnamectl", "date", "cal", "printenv", "echo", "printf", "true", "false",
  "test", "sleep", "seq", "yes", "sed", "awk", "find", "tar", "journalctl",
  "dmesg", "netstat", "ss", "ip", "ifconfig", "route", "arp", "dig", "nslookup",
  "host", "ping", "ping6", "curl", "wget", "nc", "ncat", "traceroute", "mtr",
  "systemctl", "service", "docker", "podman", "kubectl", "nginx", "apachectl",
  "caddy", "certbot", "git", "crontab", "iptables", "ufw", "smartctl", "sensors",
  "nvidia-smi", "openssl",
]);

/** Wrappers and interpreters: everything after them is invisible to the analysis. */
const WRAPPERS = new Set([
  "sudo", "su", "doas", "env", "xargs", "nice", "ionice", "nohup", "time", "timeout",
  "stdbuf", "bash", "sh", "dash", "zsh", "ksh", "fish", "python", "python3", "node",
  "deno", "bun", "perl", "ruby", "php", "lua", "eval", "source", "exec", "systemd-run",
  "at", "batch", "ssh", "scp", "sftp", "rsync", "screen", "tmux", "make", "npm",
  "yarn", "pnpm", "pip", "pip3", "git-lfs", "sqlite3", "mysql", "mysqldump", "psql",
  "redis-cli", "mongo", "defaults", "tee", "cp", "mv", "rm", "install", "dd",
  "watch", "nohup", "strace", "ltrace", "gdb",
]);

/** Tools that must never run without an explicit confirmation. */
const DANGEROUS_HEADS = new Set([
  "passwd", "chpasswd", "userdel", "groupdel", "usermod", "visudo",
  "shred", "wipefs", "blkdiscard", "fdisk", "sfdisk", "parted", "mkfs",
  "halt", "reboot", "poweroff", "shutdown", "init", "telinit", "umount",
  "chroot", "insmod", "rmmod", "modprobe", "kexec", "setenforce",
]);

/** Never auto-executable, whoever asked for them. */
const DANGEROUS: RegExp[] = [
  /\brm\s+(-{1,2}[\w-]+\s+)*-[a-z]*[rf]/i,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /\bwipefs\b/,
  /\bblkdiscard\b/,
  /\binit\s+[06]\b/,
  /\bcrontab\s+-r\b/,
  /\bchmod\s+(-{1,2}[\w-]+\s+)*0*00\b/,
  /\brm\s+-[a-z]*[rf][a-z]*\s+\/(\s|$|\*)/,
  /\bmv\s+[^\n]*\s\/(\s|$)/,
  /\bchown\s+-R\b[^\n]*\s\/(\s|$)/,
  /\bchmod\s+-R\b[^\n]*\s\/(\s|$)/,
  />\s*\/etc\/(passwd|shadow|gshadow|sudoers|fstab)/,
  />\s*\/dev\/(sd|nvme|vd|hd|mmcblk)/,
  /:\s*\(\s*\)\s*\{.*\|\s*:\s*&\s*\}/,
  /\bhistory\s+-c\b/,
  /\biptables\s+-F\b/,
  /\bip6tables\s+-F\b/,
  /\bnft\s+flush\s+ruleset\b/,
  /\bufw\s+(disable|reset)\b/,
  /\bgit\s+push\b[^\n]*(-f|--force)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*[fdx]/,
  /\bdocker\s+(rm|rmi|volume\s+(rm|prune)|system\s+prune|container\s+prune|image\s+prune)\b/,
  /\bpodman\s+(rm|rmi|volume\s+rm|system\s+prune)\b/,
  /\bkubectl\s+delete\b/,
  /\bhelm\s+(uninstall|delete)\b/,
  /\b(truncate\s+-s\s*0|>\s*\/var\/log\/)\b/,
  /\bsysctl\s+-w\b/,
  /\bmodprobe\s+-r\b/,
  /\bumount\b/,
  /\bfdisk\b[^\n]*\b[wd]\b/,
  /\bumount\b/,
  /\bsystemctl\s+(stop|disable|mask)\s+(ssh|sshd|networking|network|systemd-networkd|firewalld|ufw|docker|containerd|nginx|apache2|httpd|mysql|mariadb|postgresql)\b/,
  /\b(mysql|psql|sqlite3)\b[^\n]*\b(drop|truncate)\b/i,
  /\/dev\/(tcp|udp)\//,
  /\b(curl|wget)\b[^\n]*\|\s*(ba|z|da)?sh\b/,
];

/** Command substitution and friends can smuggle anything past the first word. */
const SUBVERSIVE: RegExp[] = [
  /\bsystem\s*\(/,
  /\bpopen\s*\(/,
  /\bexec\s*\(/,
  /\beval\s*\(/,
  /\bRuntime\.getRuntime\b/,
];

const AMPERSAND = /(^|\s)&\s*$|&&/;
const SHELL_SYNTAX = /[\n\r`;&]|\$\(|\$\{|\|\||[<>]/;
const SAFE_REDIRECT = /\d?>>?\s*\/dev\/null|<+\s*\/dev\/null|&>\s*\/dev\/null|2>&1/g;

/** Human readable one-liner for the transcript. */
export function commandSummary(command: string, max = 160): string {
  const flat = command.trim().split("\n")[0].replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function withoutSafeRedirects(command: string): string {
  return command.replace(SAFE_REDIRECT, " ");
}

/**
 * Flags that turn a normally harmless tool into a mutating one.
 * Returns false when the segment must be treated as a mutation.
 */
function flagsAllowed(head: string, args: string[]): boolean {
  const has = (re: RegExp) => args.some((a) => re.test(a));
  const first = args[0] ?? "";
  const joined = args.join(" ");
  switch (head) {
    case "sed":
      return !has(/^-i/) && !has(/^--in-place/);
    case "find":
      return !has(/^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)/);
    case "tar":
      return has(/^-{0,2}(t|list)/) || first === "-tf" || first === "-tvf";
    case "crontab":
      return has(/^-l/) || first === "-l";
    case "ip":
      return !/\b(set|add|del|delete|flush|change|replace|append)\b/.test(joined);
    case "iptables":
    case "ip6tables":
      return has(/^-[LSF]?$/) || has(/^--(list|list-rules|check)/);
    case "ufw":
      return first === "status";
    case "openssl":
      return !/\b(genrsa|genpkey|req|ca|rsa|dgst\s+-sign)\b/.test(joined);
    case "git": {
      const sub = first;
      const readOnly = new Set([
        "status", "log", "diff", "show", "branch", "remote", "describe",
        "rev-parse", "ls-files", "ls-tree", "blame", "shortlog", "tag", "stash",
        "show-ref", "for-each-ref", "reflog", "count-objects", "whatchanged",
        "cat-file", "config",
      ]);
      if (!readOnly.has(sub)) return false;
      if (sub === "branch" && args.some((a) => /^-[dDmM]/.test(a))) return false;
      if (sub === "stash" && !["list", "show"].includes(args[1] ?? "list"))
        return false;
      if (sub === "config" && !has(/^(--get|--get-all|--list|-l)$/)) return false;
      if (sub === "remote" && args.some((a) => /^(add|remove|rm|set-url|rename)$/.test(a)))
        return false;
      return true;
    }
    case "systemctl":
      return has(
        /^(status|show|list-units|list-unit-files|list-timers|list-sockets|list-dependencies|is-active|is-enabled|is-failed|is-system-running|cat|get-default|show-environment|--version|-t|--type)$/,
      );
    case "service":
      return first === "status" || first === "--status-all";
    case "docker":
    case "podman": {
      const readOnly = new Set([
        "ps", "images", "logs", "inspect", "stats", "version", "info", "df", "top",
        "port", "history", "events", "diff",
      ]);
      if (readOnly.has(first)) return true;
      // Nesting groups: only the listing subcommands are safe.
      if (["container", "image", "volume", "network", "system"].includes(first))
        return ["ls", "list", "inspect", "df", "info", "events"].includes(
          args[1] ?? "",
        );
      return false;
    }
    case "kubectl": {
      const readOnly = new Set([
        "get", "describe", "logs", "top", "version", "explain", "api-resources",
        "api-versions", "cluster-info", "auth", "config",
      ]);
      if (!readOnly.has(first)) return false;
      if (first === "config")
        return ["view", "current-context", "get-contexts", "get-clusters"].includes(
          args[1] ?? "",
        );
      return true;
    }
    case "nginx":
      return has(/^-[tTvV]$/);
    case "apachectl":
      return ["configtest", "-t", "-S", "status", "fullstatus"].includes(first);
    case "caddy":
      return ["version", "list-modules", "validate", "environ", "adapt", "help"].includes(
        first,
      );
    case "certbot":
      return (
        ["certificates", "show-account", "version", "help"].includes(first) ||
        has(/^--dry-run/)
      );
    case "journalctl":
      return !has(/^--(vacuum|rotate|flush|sync)/);
    case "mount":
      return !/\bremount\b|(^|\s)-a(\s|$)/.test(joined);
    case "curl":
    case "wget":
      return !has(
        /^(-o|-O|-d|-T|-F|-X|--output|--remote-name|--data\w*|--upload-file|--form|--request|--post\w*)$/,
      );
    default:
      return true;
  }
}

function segmentIsReadOnly(segment: string): boolean {
  const parts = segment.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  const head = parts[0].replace(/^.*\//, "");
  if (WRAPPERS.has(head) || !READ_ONLY_COMMANDS.has(head)) return false;
  return flagsAllowed(head, parts.slice(1));
}

export function classifyCommand(command: string): CommandClass {
  const raw = command.trim();
  if (!raw) return "write";
  if (DANGEROUS.some((re) => re.test(raw))) return "dangerous";
  const flat = withoutSafeRedirects(raw);
  const heads = flat
    .split("|")
    .map((segment) => segment.trim().split(/\s+/)[0] ?? "")
    .map((token) => token.replace(/^.*\//, ""))
    .filter(Boolean);
  if (heads.some((head) => DANGEROUS_HEADS.has(head))) return "dangerous";
  if (SUBVERSIVE.some((re) => re.test(flat))) return "write";
  if (SHELL_SYNTAX.test(flat) || AMPERSAND.test(flat)) return "write";
  const segments = flat
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return "write";
  return segments.every(segmentIsReadOnly) ? "read" : "write";
}

export function isDangerousCommand(command: string): boolean {
  return classifyCommand(command) === "dangerous";
}

/**
 * `read` runs inspection commands without asking, `all` also runs mutations, and
 * dangerous commands always wait for the operator.
 */
export function autoRuns(mode: AutoRunMode, kind: CommandClass): boolean {
  if (kind === "dangerous" || mode === "off") return false;
  return mode === "all" || kind === "read";
}

/** Credentials and private keys must never reach a model context. */
export function secretPath(value: string): boolean {
  return /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube)(\/|$)|(^|\/)\.env(?:\.|$)|\.(pem|key|p12|pfx)$|(^|\/)(shadow|gshadow|id_rsa|id_ed25519)$/.test(
    value,
  );
}

export function autoRunLabel(mode: AutoRunMode): string {
  if (mode === "all") return "修改类命令也自动执行";
  if (mode === "read") return "只读命令自动执行";
  return "每条命令都需要确认";
}
