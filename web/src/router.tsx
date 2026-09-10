import { createBrowserRouter, Navigate } from "react-router-dom";
import { lazy, Suspense, type ReactNode } from "react";
import { AppLayout } from "./ui/AppLayout";
import { LoginPage } from "./ui/LoginPage";
import { PublicDashboardPage } from "./ui/PublicDashboardPage";
import { PublicMachinePage } from "./ui/PublicMachinePage";
import { getToken } from "./ui/auth";
const DashboardPage = lazy(() => import("./ui/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const MachinePage = lazy(() => import("./ui/MachinePage").then((m) => ({ default: m.MachinePage })));
const MachineNewPage = lazy(() => import("./ui/MachineNewPage").then((m) => ({ default: m.MachineNewPage })));
const SettingsPage = lazy(() => import("./ui/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const SshPage = lazy(() => import("./ui/SshPage").then((m) => ({ default: m.SshPage })));
const PingPage = lazy(() => import("./ui/PingPage").then((m) => ({ default: m.PingPage })));
const BastionPage = lazy(() => import("./ui/BastionPage").then((m) => ({ default: m.BastionPage })));

function RequireAuth({ children }: { children: ReactNode }) {
  const token = getToken();
  if (!token) return <Navigate to="/login" replace />;
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
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
