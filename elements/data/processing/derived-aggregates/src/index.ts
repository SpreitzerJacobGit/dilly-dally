import { sql } from "@elements/storage-sqlite-drizzle";
import type { SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Signed sum over a movement-style log: rows of `positiveKind` add their
 * quantity, every other kind subtracts it. The core of "level is derived,
 * never stored" — the log and the level cannot disagree.
 */
export function signedSumExpr(
  kindColumn: AnySQLiteColumn,
  quantityColumn: AnySQLiteColumn,
  positiveKind: string,
): SQL<number> {
  return sql<number>`COALESCE(SUM(CASE WHEN ${kindColumn} = ${positiveKind} THEN ${quantityColumn} ELSE -${quantityColumn} END), 0)`;
}

/** Plain-TS equivalent for already-loaded rows (small lists, tests, previews). */
export function deriveLevel(
  movements: readonly { kind: string; quantity: number }[],
  positiveKind: string,
): number {
  return movements.reduce(
    (level, m) => level + (m.kind === positiveKind ? m.quantity : -m.quantity),
    0,
  );
}
