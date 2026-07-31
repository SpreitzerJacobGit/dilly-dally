import { useState, type JSX, type ReactNode } from "react";

export interface ColumnDef<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Value used for sorting; omit to make the column unsortable. */
  sortValue?: (row: T) => string | number;
}

export interface RowAction<T> {
  label: string | ((row: T) => string);
  onClick: (row: T) => void;
  /** Hide the action for rows where this returns false. */
  visible?: (row: T) => boolean;
}

export interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  rowActions?: RowAction<T>[];
  emptyMessage: string;
}

/**
 * Presentational sortable table. Data arrives from a tRPC query and actions
 * call mutations — both wired in the vertical, so every edge stays derivable.
 */
export function DataTable<T>(props: DataTableProps<T>): JSX.Element {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const sortCol = props.columns.find((c) => c.key === sortKey && c.sortValue);
  const rows = sortCol
    ? [...props.rows].sort((a, b) => {
        const va = sortCol.sortValue!(a);
        const vb = sortCol.sortValue!(b);
        return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
      })
    : props.rows;

  function toggleSort(key: string): void {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  if (props.rows.length === 0) {
    return <p>{props.emptyMessage}</p>;
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          {props.columns.map((col) => (
            <th key={col.key}>
              {col.sortValue ? (
                <button
                  type="button"
                  onClick={() => toggleSort(col.key)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    color: "inherit",
                    textTransform: "inherit",
                    letterSpacing: "inherit",
                    cursor: "pointer",
                  }}
                >
                  {col.header}
                  {sortKey === col.key ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                </button>
              ) : (
                col.header
              )}
            </th>
          ))}
          {props.rowActions?.length ? <th>Actions</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={props.rowKey(row)}>
            {props.columns.map((col) => (
              <td key={col.key}>{col.render(row)}</td>
            ))}
            {props.rowActions?.length ? (
              <td>
                {props.rowActions
                  .filter((a) => a.visible?.(row) ?? true)
                  .map((a) => {
                    const label = typeof a.label === "function" ? a.label(row) : a.label;
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => a.onClick(row)}
                        style={{ marginRight: 8, cursor: "pointer" }}
                      >
                        {label}
                      </button>
                    );
                  })}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
