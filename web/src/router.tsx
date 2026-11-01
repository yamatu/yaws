import { createBrowserRouter, Navigate } from "react-router-dom";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { AppLayout } from "./ui/AppLayout";
import { LoginPage } from "./ui/LoginPage";
import { PublicDashboardPage } from "./ui/PublicDashboardPage";
import { PublicMachinePage } from "./ui/PublicMachinePage";
import { getToken } from "./ui/auth";
import { loadSession } from "./ui/session";
const DashboardPage = lazy(() => import("./ui/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const MachinePage = lazy(() => import("./ui/MachinePage").then((m) => ({ default: m.MachinePage })));
const MachineNewPage = lazy(() => import("./ui/MachineNewPage").then((m) => ({ default: m.MachineNewPage })));
const SettingsPage = lazy(() => import("./ui/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const SshPage = lazy(() => import("./ui/SshPage").then((m) => ({ default: m.SshPage })));
const PingPage = lazy(() => import("./ui/PingPage").then((m) => ({ default: m.PingPage })));
const BastionPage = lazy(() => import("./ui/BastionPage").then((m) => ({ default: m.BastionPage })));
const CertificatesPage = lazy(() => import("./ui/CertificatesPage").then((m) => ({ default: m.CertificatesPage })));

/**
 * A cached login is only trusted after the server confirms it, so an expired
 * or revoked session lands on the login form instead of an empty dashboard.
 * Only a 401 means the login is gone: a restarting server or a network blip
 * keeps the token and retries instead of asking for the password again.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const token = getToken();
  const [state, setState] = useState<"checking" | "ok" | "bad" | "offline">(() =>
    token ? "checking" : "bad",
  );

  useEffect(() => {
    if (!token) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      loadSession()
        .then(() => {
          if (alive) setState("ok");
        })
        .catch((e: any) => {
          if (!alive) return;
          if (e?.status === 401 || e?.message === "missing_token") {
            setState("bad");
            return;
          }
          setState("offline");
          timer = setTimeout(check, 3000);
        });
    };
    check();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [token]);

  if (!token) return <Navigate to="/login" replace />;
  if (state === "bad") return <Navigate to="/login?expired=1" replace />;
  if (state === "checking") {
    return <div className="p-5 text-white/50">正在恢复登录状态…</div>;
  }
  if (state === "offline") {
    return <div className="p-5 text-white/50">暂时连不上服务器，正在重试…（登录状态已保留）</div>;
  }
  return <Suspense fallback={<div className="p-5 text-white/50">加载中…</div>}>{children}</Suspense>;
}

export const router = createBrowserRouter([
  { path: "/", element: <PublicDashboardPage /> },
  { path: "/m/:id", element: <PublicMachinePage /> },
  { path: "/login", element: <LoginPage /> },
  {
    path: "/app/machines/:id/ssh",
    element: (
      <RequireAuth>
        <SshPage />
      </RequireAuth>
    ),
  },
  {
    path: "/app",
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "machines/new", element: <MachineNewPage /> },
      { path: "machines/:id", element: <MachinePage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "ping", element: <PingPage /> },
      { path: "bastion", element: <BastionPage /> },
      { path: "certificates", element: <CertificatesPage /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
