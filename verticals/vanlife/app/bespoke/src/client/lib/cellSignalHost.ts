/**
 * Reading what the host refresh agent says about itself.
 *
 * The overlay is built by PowerShell on the van server, so the only thing this
 * app can honestly report is what the agent last wrote to the shared volume.
 * Two files, two different questions: watcher.json answers "is anything
 * polling at all", status.json answers "what happened to the run I asked for".
 * They are separate because their failures are separate — an agent that was
 * never installed and an agent that died last Tuesday need different fixes,
 * and one message for both would send the operator to the wrong place.
 *
 * Both are written by a PowerShell script, so as with readCellSignalManifest
 * in cellSignal.ts, nothing but the narrowing here stands between a typo there
 * and the rest of the app.
 *
 * One thing this cannot report: the channel is Docker, so a Docker outage
 * means the host cannot tell us it has a Docker outage. That is why every
 * message below says "has not responded" and never "is not installed".
 */

/** The agent's proof-of-life, rewritten on every poll including idle ones. */
export interface HostWatcher {
  aliveAt: string | null;
  /** Its own poll interval, so our staleness threshold tracks the installed one. */
  pollSeconds: number;
  busy: boolean;
  lastPollError: string | null;
}

export type HostRunState = "running" | "succeeded" | "failed" | "interrupted";

/** What the agent says about one refresh run. */
export interface HostRun {
  requestId: string | null;
  state: HostRunState | null;
  startedAt: string | null;
  /** Rewritten each poll while the run is alive; absent means the agent does not report it. */
  heartbeatAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** Scraped from the refresh script's own progress banners. */
  step: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function obj(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

/** The agent's default cadence, used when watcher.json omits or mangles its own. */
export const DEFAULT_POLL_SECONDS = 300;

export function readWatcherFile(raw: unknown): HostWatcher | null {
  const w = obj(raw);
  if (w === null) return null;
  const poll = w.pollSeconds;
  return {
    aliveAt: str(w.aliveAt),
    pollSeconds: typeof poll === "number" && poll > 0 ? poll : DEFAULT_POLL_SECONDS,
    busy: w.busy === true,
    lastPollError: str(w.lastPollError),
  };
}

const RUN_STATES: HostRunState[] = ["running", "succeeded", "failed", "interrupted"];

export function readStatusFile(raw: unknown): HostRun | null {
  const s = obj(raw);
  if (s === null) return null;
  const state = str(s.state);
  return {
    requestId: str(s.requestId),
    // An unrecognised state is null rather than passed through: a state we
    // cannot interpret must not be shown as if we had.
    state: RUN_STATES.find((known) => known === state) ?? null,
    startedAt: str(s.startedAt),
    heartbeatAt: str(s.heartbeatAt),
    finishedAt: str(s.finishedAt),
    error: str(s.error),
    step: str(s.step),
  };
}

export type RefreshKind =
  | "no-credentials"
  | "not-exported"
  | "no-agent"
  | "agent-stale"
  | "queued"
  | "running"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "idle";

export interface RefreshView {
  kind: RefreshKind;
  detail: string;
  /** False whenever asking again would be pointless or would queue a second run. */
  canRequest: boolean;
  tone: "plain" | "warn";
}

export interface RefreshFacts {
  /** The server's clock, not the browser's — every timestamp here is host-written. */
  now: string;
  hasCredentials: boolean;
  /** Whether the token file on the volume matches the stored username. */
  tokenExported: boolean;
  watcher: HostWatcher | null;
  run: HostRun | null;
  /** The id of the last refresh we asked for, or null if we never have. */
  pendingRequestId: string | null;
}

function ageMs(now: string, then: string | null): number | null {
  if (then === null) return null;
  const t = Date.parse(then);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return null;
  return n - t;
}

/**
 * How long silence is allowed before it means something.
 *
 * Three polls, because missing one is ordinary — the machine was busy, Docker
 * was slow. The fifteen-minute floor stops a fast poll interval turning a
 * momentary hiccup into an alarm.
 */
function staleAfterMs(watcher: HostWatcher | null): number {
  const poll = (watcher?.pollSeconds ?? DEFAULT_POLL_SECONDS) * 1000;
  return Math.max(3 * poll, 15 * 60 * 1000);
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${String(m)} minutes`;
  const h = Math.round(m / 60);
  return h === 1 ? "an hour" : `${String(h)} hours`;
}

/**
 * The whole state machine, pure so every branch is reachable from a test —
 * most of them are states you cannot conjure in a browser on demand.
 *
 * `now` is passed in rather than read from the clock because these timestamps
 * are written by the van server and the browser looking at them may be a phone
 * with a bad clock.
 */
export function cellSignalRefreshView(facts: RefreshFacts): RefreshView {
  if (!facts.hasCredentials) {
    return {
      kind: "no-credentials",
      detail:
        "No FCC credentials stored. The refresh needs an account on broadbandmap.fcc.gov before it can run.",
      canRequest: false,
      tone: "plain",
    };
  }

  if (!facts.tokenExported) {
    return {
      kind: "not-exported",
      detail:
        "Credentials are stored, but the token file is missing from the data volume, so the refresh on the van server cannot read them. Save them again to write it.",
      canRequest: false,
      tone: "warn",
    };
  }

  const stale = staleAfterMs(facts.watcher);

  if (facts.watcher === null) {
    return {
      kind: "no-agent",
      // Never "not installed": the channel is Docker, so a Docker outage looks
      // exactly like this and we cannot tell them apart from in here.
      detail:
        "No host agent has responded. If this is a new setup, run deploy/install-cell-signal-schedule.ps1 on the van server.",
      canRequest: true,
      tone: "warn",
    };
  }

  const watcherAge = ageMs(facts.now, facts.watcher.aliveAt);
  if (watcherAge === null || watcherAge > stale) {
    return {
      kind: "agent-stale",
      detail:
        watcherAge === null
          ? "The host agent has not reported a time. It may be mid-install, or writing a file this app cannot read."
          : `The host agent last responded ${minutes(watcherAge)} ago. The van server may be signed out, or Docker may not be running.`,
      canRequest: true,
      tone: "warn",
    };
  }

  const run = facts.run;
  const matched = facts.pendingRequestId !== null && run?.requestId === facts.pendingRequestId;

  if (facts.pendingRequestId !== null && !matched) {
    return {
      kind: "queued",
      detail: `Requested. The host agent picks it up within about ${minutes(facts.watcher.pollSeconds * 1000)}.`,
      canRequest: false,
      tone: "plain",
    };
  }

  if (matched && run !== null) {
    const started = run.startedAt ?? "recently";
    switch (run.state) {
      case "running": {
        const beat = ageMs(facts.now, run.heartbeatAt);
        // No heartbeat at all degrades to plain "running". An agent that does
        // not report one is not a fault, and inventing one would be.
        if (beat !== null && beat > stale) {
          return {
            kind: "interrupted",
            detail: `Started ${started} and has not reported in ${minutes(beat)}. It was probably interrupted — check Task Scheduler on the van server.`,
            canRequest: true,
            tone: "warn",
          };
        }
        return {
          kind: "running",
          detail: run.step
            ? `Running on the van server: ${run.step}. A full rebuild downloads about 66 files and can take hours.`
            : `Running on the van server since ${started}. A full rebuild downloads about 66 files and can take hours.`,
          canRequest: false,
          tone: "plain",
        };
      }
      case "succeeded":
        // Deliberately says nothing about the archive. A run that found the FCC
        // had nothing newer succeeded, and the coverage line above reports the
        // date independently.
        return {
          kind: "succeeded",
          detail: `Finished ${run.finishedAt ?? "recently"}.`,
          canRequest: true,
          tone: "plain",
        };
      case "failed":
        return {
          kind: "failed",
          detail: `Failed ${run.finishedAt ?? "recently"}: ${run.error ?? "no error was recorded"}`,
          canRequest: true,
          tone: "warn",
        };
      case "interrupted":
        return {
          kind: "interrupted",
          detail:
            "The last refresh was interrupted — the van server stopped while it was running, through a reboot, a sign-out, or the task's time limit.",
          canRequest: true,
          tone: "warn",
        };
      case null:
        break;
    }
  }

  return {
    kind: "idle",
    detail: "No refresh requested.",
    canRequest: true,
    tone: "plain",
  };
}
