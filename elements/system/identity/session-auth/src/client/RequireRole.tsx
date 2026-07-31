import type { JSX, ReactNode } from "react";

export interface RequireRoleProps {
  role: string;
  userRole: string | null;
  children: ReactNode;
  /** Rendered when the user lacks the role (default: nothing). */
  fallback?: ReactNode;
}

/**
 * UI honesty gate: hides affordances the server would reject anyway.
 * The real enforcement is roleProcedure on the server.
 */
export function RequireRole(props: RequireRoleProps): JSX.Element | null {
  if (props.userRole !== props.role) {
    return props.fallback ? <>{props.fallback}</> : null;
  }
  return <>{props.children}</>;
}
