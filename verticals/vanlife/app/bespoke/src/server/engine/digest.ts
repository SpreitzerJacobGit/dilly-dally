import { z } from "zod";
import { and, eq, type Db, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { getSetting } from "@elements/lifecycle-app-settings";
import { createNtfyPublisher, type PublishResult } from "@elements/output-ntfy-push";
import type { AppLogger } from "@elements/observability-structured-logging";
import { digests, pois, routeCandidates, stayPlans } from "../../db/schema.js";
import { formatRunway } from "../../shared/levels.js";
import { loadNeedStates } from "./needs.js";
import { budgetUsage, planDateOf, type CandidateWarning, type TripRow } from "./candidates.js";

/** Operator-set digest hour (server-local time). */
export const DIGEST_SETTINGS_KEY = "digest";
export const DigestSettingsSchema = z.object({ hour: z.number().int().min(0).max(23).default(7) });

export interface DigestBody {
  date: string;
  tripName: string;
  progressPct: number | null;
  budgetUsedPct: number | null;
  candidates: { tier: string; title: string; summary: string | null; warnings: CandidateWarning[] }[];
  needOutlook: {
    key: string;
    title: string;
    urgency: string;
    runway: number;
    /** Runway means percentage points for a level need and DAYS for a date one. */
    trackingMode: string;
    deadlineAt: string | null;
  }[];
  /** The honest cut: empty means "nothing is urgent", and says so. */
  important: string[];
}

export async function composeDigest(
  db: Db,
  trip: TripRow & { name: string },
  nowIso: string,
): Promise<{ body: DigestBody; priority: "default" | "high" }> {
  const date = planDateOf(nowIso);
  const usage = await budgetUsage(db, trip);
  const needStates = await loadNeedStates(db, trip.id, nowIso);

  const rows = await db
    .select()
    .from(routeCandidates)
    .where(
      and(
        eq(routeCandidates.tripId, trip.id),
        eq(routeCandidates.planDate, date),
        eq(routeCandidates.status, "proposed"),
      ),
    );
  const candidates = rows.map((c) => ({
    tier: c.tier,
    title: c.title,
    summary: c.summary,
    warnings: JSON.parse(c.warnings ?? "[]") as CandidateWarning[],
  }));

  const horizon = Date.parse(nowIso) + 48 * 3_600_000;
  const outlook = needStates
    .filter((s) => s.urgency !== "ok" || (s.deadlineAt !== null && Date.parse(s.deadlineAt) < horizon))
    .map((s) => ({
      key: s.need.key,
      title: s.need.title,
      urgency: s.urgency,
      runway: s.runway,
      trackingMode: s.need.trackingMode,
      deadlineAt: s.deadlineAt,
    }));

  const important: string[] = [];
  for (const s of needStates) {
    if (s.urgency === "urgent") {
      important.push(`${s.need.title}: ${formatRunway(s.runway, s.need.trackingMode)} of headroom left.`);
    }
  }
  for (const c of candidates) {
    for (const w of c.warnings) {
      if (w.severity === "urgent") important.push(`${c.title}: ${w.message}`);
    }
  }
  // Tonight's bed, when one of us has actually phoned ahead. A booking is a
  // promise to be somewhere by this evening, which belongs in the important cut
  // next to a need about to run out — and it is the one thing on this screen the
  // planner must not quietly re-rank past.
  const booked = (
    await db
      .select({ name: pois.name, state: stayPlans.state })
      .from(stayPlans)
      .innerJoin(pois, eq(pois.id, stayPlans.poiId))
      .where(and(eq(stayPlans.tripId, trip.id), eq(stayPlans.planDate, date)))
  )[0];
  if (booked && (booked.state === "booked" || booked.state === "confirmed")) {
    important.push(`Tonight is ${booked.state} at ${booked.name}.`);
  }

  // Progress = how much of the direct driving is behind us, by budget math.
  const progressPct =
    usage.baselineMinutes === null
      ? null
      : Math.min(100, Math.round((usage.spentMinutes / (usage.baselineMinutes * trip.deviationBudgetRatio)) * 100));

  return {
    body: {
      date,
      tripName: trip.name,
      progressPct,
      budgetUsedPct:
        usage.budgetMinutes === null ? null : Math.round((usage.spentMinutes / usage.budgetMinutes) * 100),
      candidates,
      needOutlook: outlook,
      important,
    },
    priority: important.length > 0 ? "high" : "default",
  };
}

export function renderDigestText(body: DigestBody): string {
  const lines: string[] = [];
  if (body.important.length > 0) {
    lines.push("IMPORTANT:");
    for (const item of body.important) lines.push(`- ${item}`);
    lines.push("");
  } else {
    lines.push("Nothing urgent today.");
    lines.push("");
  }
  lines.push(`Budget used: ${body.budgetUsedPct === null ? "—" : `${String(body.budgetUsedPct)}%`}`);
  for (const c of body.candidates) lines.push(`- [${c.tier}] ${c.title}${c.summary ? ` (${c.summary})` : ""}`);
  if (body.needOutlook.length > 0) {
    lines.push("");
    lines.push("Coming up:");
    for (const n of body.needOutlook) {
      lines.push(`- ${n.title}: ${formatRunway(n.runway, n.trackingMode)} headroom${n.deadlineAt ? `, deadline ${n.deadlineAt.slice(0, 16).replace("T", " ")}` : ""} [${n.urgency}]`);
    }
  }
  return lines.join("\n");
}

/** Compose, persist for the banner, and push (at-most-once per trip-date). */
export async function generateAndDeliverDigest(
  dbHandle: DbHandle,
  logger: AppLogger,
  trip: TripRow & { name: string },
  nowIso: string,
  opts?: { forcePush?: boolean },
): Promise<{ persisted: boolean; push: PublishResult }> {
  const db = dbHandle.db;
  const { body, priority } = await composeDigest(db, trip, nowIso);
  const date = body.date;

  const existing = await db
    .select({ id: digests.id })
    .from(digests)
    .where(and(eq(digests.tripId, trip.id), eq(digests.date, date)));
  if (existing.length === 0) {
    await db.insert(digests).values({
      tripId: trip.id,
      date,
      body: JSON.stringify(body),
      priority,
      generatedAt: new Date().toISOString(),
    });
  } else {
    await db
      .update(digests)
      .set({ body: JSON.stringify(body), priority, generatedAt: new Date().toISOString() })
      .where(eq(digests.id, existing[0]!.id));
  }

  const publisher = createNtfyPublisher({ dbHandle, logger });
  const msg = {
    title: `${trip.name} — ${body.progressPct === null ? "planning" : `${String(body.progressPct)}% of budget`}`,
    body: renderDigestText(body),
    priority,
    tags: ["minibus"],
  };
  const push = opts?.forcePush
    ? await publisher.publish(msg)
    : await publisher.publishOnce(`digest-${String(trip.id)}-${date}`, msg);
  return { persisted: true, push };
}

/**
 * Urgent replan warnings push immediately (not at digest hour) — once per
 * need per day, so a stream of replans cannot spam the topic.
 */
export async function pushUrgentWarnings(
  dbHandle: DbHandle,
  logger: AppLogger,
  trip: TripRow & { name: string },
  warnings: CandidateWarning[],
  nowIso: string,
): Promise<void> {
  const urgent = warnings.filter((w) => w.severity === "urgent");
  if (urgent.length === 0) return;
  const publisher = createNtfyPublisher({ dbHandle, logger });
  const date = planDateOf(nowIso);
  for (const w of urgent) {
    await publisher.publishOnce(`urgent-${String(trip.id)}-${date}-${w.needKey ?? "budget"}`, {
      title: `${trip.name}: needs attention`,
      body: w.message,
      priority: "urgent",
      tags: ["rotating_light"],
    });
  }
}

export async function digestHour(db: Db): Promise<number> {
  const stored = await getSetting(db, DIGEST_SETTINGS_KEY, DigestSettingsSchema);
  return stored?.value.hour ?? 7;
}
