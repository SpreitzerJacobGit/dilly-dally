import { useCallback, useEffect, useState } from "react";
import { trpc } from "../trpc.js";
import { readViewedTripId, writeViewedTripId } from "../lib/prefs.js";

/**
 * Which trip the planning screen is showing.
 *
 * Viewing is not activating. The active trip is the one the van is on: it is
 * what the morning digest is generated for and what mileage-driven needs are
 * computed against. Being able to lay out next spring's trip without disturbing
 * either of those is the whole point of having a picker, so the selection lives
 * in the browser and `status` is left alone until someone says otherwise.
 */

export interface PlannerTripState {
  isLoading: boolean;
  /** The trip being shown, or null when there are none. */
  tripId: number | null;
  trips: { id: number; name: string; status: string; originName: string; destName: string }[];
  activeTripId: number | null;
  activeTripName: string | null;
  /** True when the screen is showing a trip the van is not on. */
  viewingNonActive: boolean;
  select: (id: number) => void;
  /** Set after creating a trip, so the screen follows what was just made. */
  adopt: (id: number) => void;
  /** Non-null when the stored selection pointed at a trip that no longer exists. */
  recovered: string | null;
  clearRecovered: () => void;
}

export function usePlannerTrip(): PlannerTripState {
  const listQ = trpc.trips.list.useQuery();
  const activeQ = trpc.trips.active.useQuery();
  const [selected, setSelected] = useState<number | null>(() => readViewedTripId());
  const [recovered, setRecovered] = useState<string | null>(null);

  const trips = listQ.data ?? [];
  const activeTripId = activeQ.data?.id ?? null;

  // Resolution runs against loaded data, so a stored id that no longer exists
  // falls back on its own rather than leaving the screen pointed at nothing.
  const exists = selected !== null && trips.some((t) => t.id === selected);
  const resolved = exists ? selected : (activeTripId ?? trips[0]?.id ?? null);

  useEffect(() => {
    if (listQ.isLoading || selected === null || exists) return;
    // Say so. A screen that silently swaps out from under you is the failure
    // mode this app is built to avoid.
    const fallback = trips.find((t) => t.id === resolved);
    setRecovered(
      fallback
        ? `The trip you were viewing is gone — showing "${fallback.name}" instead.`
        : "The trip you were viewing is gone.",
    );
    setSelected(resolved);
    writeViewedTripId(resolved);
  }, [listQ.isLoading, selected, exists, resolved, trips]);

  const select = useCallback((id: number) => {
    setSelected(id);
    writeViewedTripId(id);
  }, []);

  return {
    isLoading: listQ.isLoading,
    tripId: resolved,
    trips,
    activeTripId,
    activeTripName: activeQ.data?.name ?? null,
    viewingNonActive: resolved !== null && activeTripId !== null && resolved !== activeTripId,
    select,
    adopt: select,
    recovered,
    clearRecovered: () => setRecovered(null),
  };
}
