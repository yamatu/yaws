import { Link, Outlet, useNavigate } from "react-router-dom";
import { clearToken } from "./auth";

export function AppLayout() {
  const nav = useNavigate();
  return (
    <div className="mx-auto max-w-6xl px-5 py-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex-1">
          <Link to="/app" className="font-extrabold tracking-wide">
            YAWS
          </Link>
          <span className="ml-2 text-sm text-white/60">探针监控</span>
        </div>
        <Link
          className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15"
          to="machines/new"
        >
          新增机器
        </Link>
        <Link className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15" to="settings">
          账号设置
        </Link>
        <button
          className="rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm hover:bg-white/15"
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
