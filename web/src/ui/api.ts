import { getToken } from "./auth";

export const API_BASE = "";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    const err = new Error(body?.error ?? `http_${res.status}`);
    (err as any).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export async function apiFetchText(path: string, init?: RequestInit): Promise<string> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    const err = new Error(body?.error ?? `http_${res.status}`);
    (err as any).status = res.status;
    throw err;
  }
  return await res.text();
}

export type Machine = {
  id: number;
  name: string;
  notes: string;
  sortOrder: number;
  groupName: string;
  hostname?: string;
  osName?: string;
  osVersion?: string;
  arch?: string;
  kernelVersion?: string;
  cpuModel?: string;
  cpuCores?: number;
  intervalSec: number;
  agentWsUrl: string;
  expiresAt: number | null;
  purchaseAmountCents: number;
  billingCycle: "month" | "quarter" | "half_year" | "year" | "two_year" | "three_year";
  autoRenew: 0 | 1;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
  online: 0 | 1;
};

export type MachineSummary = Machine & { latestMetric: Metric | null };

export type Metric = {
  at: number;
  cpuUsage: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  netRxBytes: number;
  netTxBytes: number;
  load1: number;
  load5: number;
  load15: number;
};

export type PublicMachine = {
  id: number;
  name: string;
  online: 0 | 1;
  lastSeenAt: number | null;
  expiresAt: number | null;
  billingCycle: "month" | "quarter" | "half_year" | "year" | "two_year" | "three_year";
  autoRenew: 0 | 1;
  groupName?: string;
  latestMetric: (Metric & { netRxBytes: number; netTxBytes: number; load1: number; load5: number; load15: number }) | null;
};

export type PublicMachineDetail = {
  machine: {
    id: number;
    name: string;
    notes: string;
    sortOrder: number;
    groupName: string;
    hostname: string;
    osName: string;
    osVersion: string;
    arch: string;
    kernelVersion: string;
    cpuModel: string;
    cpuCores: number;
    intervalSec: number;
    agentWsUrl: string;
    expiresAt: number | null;
    purchaseAmountCents: number;
    billingCycle: "month" | "quarter" | "half_year" | "year" | "two_year" | "three_year";
    autoRenew: 0 | 1;
    createdAt: number;
    updatedAt: number;
    lastSeenAt: number | null;
    online: 0 | 1;
  };
  metrics: Metric[];
};
