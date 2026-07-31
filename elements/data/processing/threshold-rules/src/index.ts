export type ThresholdStatus = "ok" | "low" | "out";

export interface ThresholdInput {
  level: number;
  /** null = no threshold configured; such items are never alerts. */
  threshold: number | null;
}

export interface ThresholdState {
  status: ThresholdStatus;
  /** How far below the threshold the level sits (0 when not low). */
  deficit: number;
}

/**
 * The threshold predicate: at or below the threshold is "low", at or below
 * zero is "out". Deterministic and total — every input has exactly one state.
 */
export function evaluateThreshold(input: ThresholdInput): ThresholdState {
  if (input.level <= 0) {
    return { status: "out", deficit: input.threshold === null ? 0 : Math.max(input.threshold - input.level, 0) };
  }
  if (input.threshold !== null && input.level <= input.threshold) {
    return { status: "low", deficit: input.threshold - input.level };
  }
  return { status: "ok", deficit: 0 };
}

export interface AlertRow<T> {
  item: T;
  state: ThresholdState;
}

/** Filter to active alerts, most urgent (largest deficit) first. */
export function activeAlerts<T>(
  items: readonly T[],
  read: (item: T) => ThresholdInput,
): AlertRow<T>[] {
  return items
    .map((item) => ({ item, state: evaluateThreshold(read(item)) }))
    .filter((row) => row.state.status !== "ok")
    .sort((a, b) => b.state.deficit - a.state.deficit);
}
