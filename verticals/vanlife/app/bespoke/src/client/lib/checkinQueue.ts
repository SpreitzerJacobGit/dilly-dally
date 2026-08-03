/**
 * Offline check-in queue — the ONE queued write in the app. A check-in that
 * fails on a network error is stored locally with a client-generated id (the
 * server dedupes on it) and replayed on reconnect/focus/startup. Everything
 * else fails visibly.
 */

import { CHECKIN_QUEUE_KEY as KEY } from "./prefs.js";

export interface QueuedCheckIn {
  clientId: string;
  needId: number;
  kind: "service" | "set-level";
  quantity?: number;
  note?: string;
  /** Where we were, when the device offered it freely. Optional forever: older
   *  queued entries predate it, and a check-in never required a location. */
  location?: { lat: number; lng: number };
  occurredAt: string;
}

export function newClientId(): string {
  return `ci-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
}

export function readQueue(): QueuedCheckIn[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as QueuedCheckIn[];
  } catch {
    return [];
  }
}

export function enqueue(item: QueuedCheckIn): void {
  localStorage.setItem(KEY, JSON.stringify([...readQueue(), item]));
}

export function removeFromQueue(clientId: string): void {
  localStorage.setItem(KEY, JSON.stringify(readQueue().filter((q) => q.clientId !== clientId)));
}

/** Replays queued check-ins through the given sender; stops on first failure. */
export async function flushQueue(
  send: (item: QueuedCheckIn) => Promise<unknown>,
): Promise<{ flushed: number; remaining: number }> {
  let flushed = 0;
  for (const item of readQueue()) {
    try {
      await send(item);
      removeFromQueue(item.clientId);
      flushed++;
    } catch {
      break; // still offline — keep the rest for later
    }
  }
  return { flushed, remaining: readQueue().length };
}
