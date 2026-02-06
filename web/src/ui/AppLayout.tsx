import { Link, Outlet, useNavigate } from "react-router-dom";
import { clearToken } from "./auth";

export function AppLayout() {
  const nav = useNavigate();
  return (
    <div className="mx-auto max-w-6xl px-5 py-5">
      <div className="mb-6 flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.03] px-5 py-3.5 backdrop-blur-xl">
        <div className="flex-1">
          <Link to="/app" className="text-lg font-extrabold tracking-wider text-white/95">
            YAWS
          </Link>
          <span className="ml-2.5 text-sm text-white/40">探针监控</span>
        </div>
        <Link className="yaws-btn" to="machines/new">
          新增机器
        </Link>
        <Link className="yaws-btn" to="settings">
          账号设置
        </Link>
        <button
          className="yaws-btn"
          onClick={() => {
            clearToken();
            nav("/login", { replace: true });
          }}
        >
          退出
        </button>
      </div>
      <Outlet />
    </div>
  );
}
