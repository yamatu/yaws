import { Link, Outlet, useNavigate } from "react-router-dom";
import { currentUser, forgetSession } from "./session";

export function AppLayout() {
  const nav = useNavigate();
  const user = currentUser();
  return (
    <div className="mx-auto max-w-6xl px-5 py-5">
      <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-white/[0.1] px-1 py-3.5">
        <div className="flex-1">
          <Link to="/app" className="text-lg font-extrabold tracking-wider text-white/95">
            YAWS
          </Link>
          <span className="ml-2.5 text-sm text-white/40">探针监控</span>
          {user ? (
            <span className="ml-2.5 text-xs text-white/35" title={user.role}>
              已登录：{user.username}
            </span>
          ) : null}
        </div>
        <Link className="yaws-btn" to="machines/new">
          新增机器
        </Link>
        <Link className="yaws-btn" to="settings">
          账号设置
        </Link>
        <Link className="yaws-btn" to="ping">延迟监控</Link>
        <Link className="yaws-btn" to="bastion">堡垒机</Link>
        <Link className="yaws-btn" to="certificates">证书管理</Link>
        <button
          className="yaws-btn"
          onClick={() => {
            forgetSession();
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
