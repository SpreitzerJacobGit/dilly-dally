import type { JSX, ReactNode } from "react";
import { NavLink } from "react-router-dom";

export interface NavItem {
  label: string;
  to: string;
  /** When set, the item is shown only to users with this role. */
  requiresRole?: string;
}

export interface ShellUser {
  email: string;
  role: string;
}

export interface AppShellProps {
  appName: string;
  nav: NavItem[];
  user: ShellUser;
  onLogout: () => void;
  children: ReactNode;
}

const styles = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; color: #1a1a1a; background: #f6f6f4; }
  .shell-header { display: flex; align-items: center; gap: 24px; padding: 0 24px; height: 56px;
    background: #234236; color: #fff; }
  .shell-header h1 { font-size: 1.05rem; margin: 0; font-weight: 600; }
  .shell-nav { display: flex; gap: 4px; flex: 1; }
  .shell-nav a { color: #cfe0d6; text-decoration: none; padding: 8px 12px; border-radius: 6px; font-size: 0.95rem; }
  .shell-nav a:hover { background: rgba(255,255,255,0.12); color: #fff; }
  .shell-nav a.active { background: rgba(255,255,255,0.18); color: #fff; font-weight: 600; }
  .shell-user { display: flex; align-items: center; gap: 12px; font-size: 0.85rem; color: #cfe0d6; }
  .shell-user button { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,0.4);
    border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 0.85rem; }
  .shell-user button:hover { background: rgba(255,255,255,0.12); }
  .shell-main { max-width: 1080px; margin: 24px auto; padding: 0 24px; }
  .shell-main h2 { font-size: 1.3rem; }
  table.data-table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
  table.data-table th { text-align: left; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em;
    color: #555; padding: 10px 14px; border-bottom: 2px solid #eee; background: #fafaf8; }
  table.data-table td { padding: 10px 14px; border-bottom: 1px solid #f0f0ee; font-size: 0.95rem; }
  table.data-table tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .badge.low { background: #fdecea; color: #b3261e; }
  .badge.ok { background: #e6f4ea; color: #1e7b34; }
  .card { background: #fff; border-radius: 8px; padding: 16px 20px; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
  form.stacked label { display: block; margin-top: 12px; font-size: 0.9rem; font-weight: 500; }
  form.stacked input, form.stacked select { display: block; width: 100%; max-width: 420px; padding: 8px;
    margin-top: 4px; border: 1px solid #ccc; border-radius: 6px; font-size: 0.95rem; }
  form.stacked button[type=submit] { margin-top: 16px; padding: 10px 20px; background: #234236; color: #fff;
    border: none; border-radius: 6px; cursor: pointer; font-size: 0.95rem; }
  form.stacked button[type=submit]:hover { background: #2e5546; }
  .field-error { color: #b3261e; font-size: 0.85rem; margin: 4px 0 0; }
  .form-error { color: #b3261e; margin-top: 12px; }
`;

/** Navigation, layout, and theming. Nav items gated by role never render for other roles. */
export function AppShell(props: AppShellProps): JSX.Element {
  const visibleNav = props.nav.filter(
    (item) => !item.requiresRole || item.requiresRole === props.user.role,
  );
  return (
    <>
      <style>{styles}</style>
      <header className="shell-header">
        <h1>{props.appName}</h1>
        <nav className="shell-nav" aria-label="Main navigation">
          {visibleNav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="shell-user">
          <span>
            {props.user.email} ({props.user.role})
          </span>
          <button type="button" onClick={props.onLogout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="shell-main">{props.children}</main>
    </>
  );
}
