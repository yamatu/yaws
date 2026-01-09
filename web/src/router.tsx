import { createBrowserRouter, Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { AppLayout } from "./ui/AppLayout";
import { LoginPage } from "./ui/LoginPage";
import { DashboardPage } from "./ui/DashboardPage";
import { MachinePage } from "./ui/MachinePage";
import { MachineNewPage } from "./ui/MachineNewPage";
import { PublicDashboardPage } from "./ui/PublicDashboardPage";
import { SettingsPage } from "./ui/SettingsPage";
import { getToken } from "./ui/auth";

function RequireAuth({ children }: { children: ReactNode }) {
  const token = getToken();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export const router = createBrowserRouter([
  { path: "/", element: <PublicDashboardPage /> },
  { path: "/login", element: <LoginPage /> },
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
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
