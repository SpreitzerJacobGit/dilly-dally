import { useState, type JSX } from "react";

export interface FieldSpec {
  name: string;
  label: string;
  type?: "text" | "number" | "password" | "textarea" | "date" | "select";
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
  step?: string;
  required?: boolean;
  /** For type "select" — a closed set beats a free-text field the server must reject. */
  options?: { value: string; label: string }[];
  /** Shown under the field; for explaining what a threshold or interval means. */
  hint?: string;
}

/**
 * The one modal form. Real inputs with labels — never window.prompt(), which
 * is untestable, undriveable by automation, and miserable on a phone.
 * Client-side validation keeps obviously invalid values from ever reaching
 * the server; the server remains the authority.
 */
export function FormModal(props: {
  title: string;
  fields: FieldSpec[];
  submitLabel?: string;
  hint?: string;
  onSubmit: (values: Record<string, string>) => void;
  onClose: () => void;
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(props.fields.map((f) => [f.name, f.defaultValue ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    for (const f of props.fields) {
      const raw = values[f.name] ?? "";
      if (f.required && raw.trim() === "") return `${f.label} is required`;
      if (f.type === "number" && raw.trim() !== "") {
        const n = Number(raw);
        if (Number.isNaN(n)) return `${f.label} must be a number`;
        if (f.min !== undefined && n < f.min) return `${f.label} must be at least ${String(f.min)}`;
        if (f.max !== undefined && n > f.max) return `${f.label} must be at most ${String(f.max)}`;
      }
    }
    return null;
  }

  return (
    <div className="vl-modal-backdrop" onClick={props.onClose}>
      <div className="vl-modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{props.title}</h3>
        {props.hint ? <p style={{ color: "#666", fontSize: ".85rem" }}>{props.hint}</p> : null}
        {props.fields.map((f) => (
          <label key={f.name} style={{ display: "block", fontSize: ".85rem", marginBottom: 10 }}>
            {f.label}
            {f.type === "textarea" ? (
              <textarea
                value={values[f.name] ?? ""}
                placeholder={f.placeholder}
                rows={5}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                style={{ display: "block", width: "100%", padding: 6, marginTop: 4, fontFamily: "monospace" }}
              />
            ) : f.type === "select" ? (
              <select
                value={values[f.name] ?? ""}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                style={{ display: "block", width: "100%", padding: 6, marginTop: 4 }}
              >
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.type ?? "text"}
                value={values[f.name] ?? ""}
                placeholder={f.placeholder}
                min={f.min}
                max={f.max}
                step={f.step ?? (f.type === "number" ? "any" : undefined)}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                style={{ display: "block", width: "100%", padding: 6, marginTop: 4 }}
              />
            )}
            {f.hint ? (
              <span style={{ display: "block", color: "#666", fontSize: ".75rem", marginTop: 2 }}>{f.hint}</span>
            ) : null}
          </label>
        ))}
        {error ? <p style={{ color: "#b3261e", fontSize: ".85rem" }}>{error}</p> : null}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="vl-checkin-btn"
            style={{ fontWeight: 700 }}
            onClick={() => {
              const problem = validate();
              if (problem) {
                setError(problem);
                return;
              }
              props.onSubmit(values);
              props.onClose();
            }}
          >
            {props.submitLabel ?? "Save"}
          </button>
          <button className="vl-checkin-btn" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
