import type { JSX, ReactNode } from "react";

export interface StatCardProps {
  label: string;
  value: string | number;
  tone?: "neutral" | "good" | "alert";
  detail?: string;
}

const toneColors: Record<NonNullable<StatCardProps["tone"]>, string> = {
  neutral: "#1a1a1a",
  good: "#1e7b34",
  alert: "#b3261e",
};

/** A headline number with a label — the dashboard's unit of truth. */
export function StatCard(props: StatCardProps): JSX.Element {
  return (
    <div className="card" style={{ minWidth: 180 }}>
      <div style={{ fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "#666" }}>
        {props.label}
      </div>
      <div style={{ fontSize: "2rem", fontWeight: 700, color: toneColors[props.tone ?? "neutral"] }}>
        {props.value}
      </div>
      {props.detail ? <div style={{ fontSize: "0.85rem", color: "#666" }}>{props.detail}</div> : null}
    </div>
  );
}

export interface DashboardGridProps {
  children: ReactNode;
}

export function DashboardGrid(props: DashboardGridProps): JSX.Element {
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
      {props.children}
    </div>
  );
}
