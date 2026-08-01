import type { JSX } from "react";

/**
 * A confirmation the app owns.
 *
 * window.confirm is untestable, undriveable by automation, and on a phone it
 * renders as a browser-chrome alert that looks nothing like the app — the same
 * objections FormModal already records against window.prompt. This reuses the
 * modal shell, so it becomes a bottom sheet on a phone like every other dialog.
 */

export interface ConfirmModalProps {
  title: string;
  body: string;
  confirmLabel: string;
  /** Marks the action as destructive, so the button reads as one. */
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmModal(props: ConfirmModalProps): JSX.Element {
  return (
    <div className="vl-modal-backdrop" onClick={props.onClose}>
      <div className="vl-modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{props.title}</h3>
        <p>{props.body}</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="vl-checkin-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="vl-checkin-btn"
            style={props.destructive ? { background: "#b91c1c", color: "#fff", borderColor: "#b91c1c" } : {}}
            onClick={() => {
              props.onConfirm();
              props.onClose();
            }}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
