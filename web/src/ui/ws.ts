import { getToken } from "./auth";

export type WsEvent =
  | { type: "hello"; userId: number }
  | { type: "subscribed"; machineIds: number[] }
  | { type: "machine_status"; machineId: number; online: boolean; lastSeenAt: number }
  | {
      type: "metrics";
      machineId: number;
      metric: {
        at: number;
        cpu: { usage: number };
        mem: { used: number; total: number };
        disk: { used: number; total: number };
        net?: { rxBytes: number; txBytes: number };
        conn?: { tcp: number; udp: number };
        load?: { l1: number; l5: number; l15: number };
      };
      monthTraffic?: { month: string; startAt?: number; endAt?: number; rxBytes: number; txBytes: number; updatedAt?: number };
    }
  | { type: "error"; error: string };

export function connectUiWs(opts: {
  onEvent: (ev: WsEvent) => void;
  onClose: () => void;
  onError?: (err: Event) => void;
}) {
  const token = getToken();
  if (!token) throw new Error("missing_token");
  const url = new URL("/ws/ui", window.location.origin);
  url.searchParams.set("token", token);
  const ws = new WebSocket(url.toString().replace(/^http/, "ws"));
  ws.onmessage = (e) => {
    try {
      opts.onEvent(JSON.parse(e.data));
    } catch {
      // ignore
    }
  };
  ws.onclose = () => opts.onClose();
  ws.onerror = (err) => opts.onError?.(err);
  return ws;
}
