import { useState, type JSX } from "react";
import { readDigestDismissed, writeDigestDismissed } from "../lib/prefs.js";

export interface DigestView {
  date: string;
  priority: string;
  body: {
    progressPct: number | null;
    budgetUsedPct: number | null;
    important: string[];
    needOutlook: { title: string; urgency: string; deadlineAt: string | null }[];
  };
}

/**
 * The morning digest as a dismissible overlay. Dismissal is scoped per
 * OPERATOR per device (DIG-3): one operator clearing it never hides it from
 * the other — not even when they share a browser.
 */
export function DigestBanner(props: { digest: DigestView | null; userKey: string }): JSX.Element | null {
  const [dismissedDate, setDismissedDate] = useState<string | null>(
    () => readDigestDismissed(props.userKey),
  );
  const [expanded, setExpanded] = useState(false);
  const d = props.digest;
  if (!d || dismissedDate === d.date) return null;

  const urgent = d.body.important.length > 0;
  return (
    <div className={`vl-banner${urgent ? " vl-banner-urgent" : ""}`}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h4 onClick={() => setExpanded(!expanded)} style={{ cursor: "pointer" }}>
          Morning digest · {d.date}
          {d.body.budgetUsedPct !== null ? ` · ${String(d.body.budgetUsedPct)}% budget used` : ""}
          {urgent ? ` · ${String(d.body.important.length)} important` : " · nothing urgent"}
        </h4>
        <button
          className="vl-checkin-btn"
          style={{ padding: "0 8px" }}
          onClick={() => {
            writeDigestDismissed(props.userKey, d.date);
            setDismissedDate(d.date);
          }}
          title="Dismiss for me on this device"
        >
          ×
        </button>
      </div>
      {expanded || urgent ? (
        <ul>
          {d.body.important.map((line, i) => (
            <li key={i} style={{ color: "#b3261e" }}>{line}</li>
          ))}
          {expanded
            ? d.body.needOutlook.map((n, i) => (
                <li key={`o${String(i)}`}>
                  {n.title}: {n.urgency}
                  {n.deadlineAt ? ` — deadline ${n.deadlineAt.slice(5, 16).replace("T", " ")}` : ""}
                </li>
              ))
            : null}
        </ul>
      ) : null}
    </div>
  );
}
