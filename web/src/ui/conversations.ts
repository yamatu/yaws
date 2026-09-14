/** Pure helpers behind the conversation picker. */
export type Conversation = {
  id: string;
  title: string;
  root: string;
  model?: string;
  createdAt?: number;
  updatedAt: number;
  turns: number;
  preview?: string;
  lastStatus?: string;
};

const DAY_MS = 86_400_000;

export function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** Short, human readable age such as "刚刚", "12 分钟前" or "2026-03-04". */
export function relativeTime(now: number, ts: number): string {
  if (!ts) return "";
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (days <= 0) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type ConversationGroup = {
  key: "today" | "yesterday" | "week" | "older";
  label: string;
  items: Conversation[];
};

const GROUP_LABELS: Array<[ConversationGroup["key"], string]> = [
  ["today", "今天"],
  ["yesterday", "昨天"],
  ["week", "最近 7 天"],
  ["older", "更早"],
];

function bucketOf(now: number, ts: number): ConversationGroup["key"] {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "older";
}

/** Newest first, split into empty-free day buckets. */
export function groupConversations(
  list: Conversation[],
  now: number,
): ConversationGroup[] {
  const sorted = list
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const buckets = new Map<ConversationGroup["key"], Conversation[]>();
  for (const item of sorted) {
    const key = bucketOf(now, item.updatedAt || now);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return GROUP_LABELS.filter(([key]) => buckets.has(key)).map(
    ([key, label]) => ({ key, label, items: buckets.get(key)! }),
  );
}

/** Case-insensitive match over everything the picker shows. */
export function filterConversations(
  list: Conversation[],
  query: string,
): Conversation[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return list;
  return list.filter((item) =>
    [item.title, item.root, item.model ?? "", item.preview ?? ""].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}

/** The order the rows are rendered in, used to drive arrow-key navigation. */
export function visibleConversations(
  list: Conversation[],
  query: string,
  now: number,
): Conversation[] {
  return groupConversations(filterConversations(list, query), now).flatMap(
    (group) => group.items,
  );
}
