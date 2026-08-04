/**
 * What the Settings page is allowed to say about the host refresh agent.
 *
 * Every state here is reachable on a real van and most are awkward to reach in
 * a browser: an agent that was never installed, one that died mid-run when the
 * machine rebooted, a status file left over from last month. The rule they all
 * serve is that the page must never claim something it has not been told —
 * "requested" that hangs forever is the failure this whole state machine
 * exists to prevent.
 */
import { describe, expect, it } from "vitest";
import {
  cellSignalRefreshView,
  readStatusFile,
  readWatcherFile,
  type RefreshFacts,
  type RefreshKind,
} from "../src/client/lib/cellSignalHost.js";

const NOW = "2026-08-04T12:00:00Z";

/** A healthy agent that answered a minute ago. */
const alive = readWatcherFile({
  aliveAt: "2026-08-04T11:59:00Z",
  pollSeconds: 300,
  busy: false,
  lastPollError: null,
});

function facts(over: Partial<RefreshFacts> = {}): RefreshFacts {
  return {
    now: NOW,
    hasCredentials: true,
    tokenExported: true,
    watcher: alive,
    run: null,
    pendingRequestId: null,
    ...over,
  };
}

describe("readWatcherFile / readStatusFile", () => {
  it("reads junk as absent rather than throwing", () => {
    for (const junk of [null, undefined, "watcher", 42, []]) {
      expect(() => readWatcherFile(junk)).not.toThrow();
      expect(() => readStatusFile(junk)).not.toThrow();
    }
    expect(readWatcherFile("watcher")).toBeNull();
    expect(readStatusFile(7)).toBeNull();
  });

  it("falls back to the default cadence when the agent omits its own", () => {
    expect(readWatcherFile({ aliveAt: NOW })?.pollSeconds).toBe(300);
    expect(readWatcherFile({ aliveAt: NOW, pollSeconds: 0 })?.pollSeconds).toBe(300);
  });

  it("drops a run state it does not recognise instead of passing it through", () => {
    // A state we cannot interpret must not reach the page looking interpreted.
    expect(readStatusFile({ requestId: "a", state: "reticulating" })?.state).toBeNull();
    expect(readStatusFile({ requestId: "a", state: "running" })?.state).toBe("running");
  });

  it("treats empty strings as absent", () => {
    const run = readStatusFile({ requestId: "", error: "", heartbeatAt: "" });
    expect(run?.requestId).toBeNull();
    expect(run?.error).toBeNull();
    expect(run?.heartbeatAt).toBeNull();
  });
});

describe("cellSignalRefreshView", () => {
  it("asks for credentials before anything else", () => {
    const view = cellSignalRefreshView(facts({ hasCredentials: false, watcher: null }));
    expect(view.kind).toBe("no-credentials");
    // No point offering a refresh that cannot authenticate.
    expect(view.canRequest).toBe(false);
  });

  it("distinguishes stored credentials from exported ones", () => {
    // `docker compose down -v` wipes the volume but not the database, so this
    // is an ordinary state and it has its own fix: save them again.
    const view = cellSignalRefreshView(facts({ tokenExported: false }));
    expect(view.kind).toBe("not-exported");
    expect(view.detail).toMatch(/save them again/i);
    expect(view.canRequest).toBe(false);
  });

  it("names the installer when nothing has ever responded", () => {
    const view = cellSignalRefreshView(facts({ watcher: null }));
    expect(view.kind).toBe("no-agent");
    expect(view.detail).toMatch(/install-cell-signal-schedule\.ps1/);
  });

  it("never claims the agent is uninstalled, because it cannot know that", () => {
    // The channel is Docker. A Docker outage looks exactly like an agent that
    // was never installed, and blaming the wrong one sends the operator to the
    // wrong place.
    expect(cellSignalRefreshView(facts({ watcher: null })).detail).not.toMatch(/not installed/i);
  });

  it("separates an agent that died from one that never existed", () => {
    const dead = readWatcherFile({ aliveAt: "2026-08-04T10:00:00Z", pollSeconds: 300 });
    const view = cellSignalRefreshView(facts({ watcher: dead }));
    expect(view.kind).toBe("agent-stale");
    expect(view.detail).toMatch(/signed out|Docker/i);
    // Retryable: the fix is on the host, and the operator will want to press
    // again once they have applied it.
    expect(view.canRequest).toBe(true);
  });

  it("takes its staleness threshold from the agent's own cadence", () => {
    // Twenty minutes of silence is fine for a five-minute poll and not fine
    // for a slow one, so the threshold has to travel with the interval.
    const slow = readWatcherFile({ aliveAt: "2026-08-04T11:40:00Z", pollSeconds: 600 });
    expect(cellSignalRefreshView(facts({ watcher: slow })).kind).toBe("idle");
    const fast = readWatcherFile({ aliveAt: "2026-08-04T11:20:00Z", pollSeconds: 60 });
    expect(cellSignalRefreshView(facts({ watcher: fast })).kind).toBe("agent-stale");
  });

  it("reports a request the agent has not claimed as queued", () => {
    const view = cellSignalRefreshView(facts({ pendingRequestId: "req-1" }));
    expect(view.kind).toBe("queued");
    // Pressing again would only overwrite the request we are already waiting on.
    expect(view.canRequest).toBe(false);
  });

  it("does not let last month's status answer this month's request", () => {
    // The correlation id is the whole reason a leftover status file cannot make
    // a brand-new request look already finished.
    const stale = readStatusFile({
      requestId: "req-OLD",
      state: "succeeded",
      finishedAt: "2026-07-01T00:00:00Z",
    });
    expect(cellSignalRefreshView(facts({ pendingRequestId: "req-1", run: stale })).kind).toBe("queued");
  });

  it("reports a claimed run as running, with the step it is on", () => {
    const run = readStatusFile({
      requestId: "req-1",
      state: "running",
      startedAt: "2026-08-04T11:30:00Z",
      heartbeatAt: "2026-08-04T11:59:30Z",
      step: "Downloading FCC mobile availability",
    });
    const view = cellSignalRefreshView(facts({ pendingRequestId: "req-1", run }));
    expect(view.kind).toBe("running");
    expect(view.detail).toMatch(/Downloading FCC/);
    // A second run must not be queueable while one is live.
    expect(view.canRequest).toBe(false);
  });

  it("calls a running job with a dead heartbeat interrupted", () => {
    const run = readStatusFile({
      requestId: "req-1",
      state: "running",
      startedAt: "2026-08-04T09:00:00Z",
      heartbeatAt: "2026-08-04T09:05:00Z",
    });
    const view = cellSignalRefreshView(facts({ pendingRequestId: "req-1", run }));
    expect(view.kind).toBe("interrupted");
    expect(view.detail).toMatch(/interrupted/i);
    expect(view.canRequest).toBe(true);
  });

  it("never invents a fault when the agent reports no heartbeat at all", () => {
    // Degrading to plain "running" is the honest reading: an agent that does
    // not report a heartbeat has told us nothing about whether it is alive.
    const run = readStatusFile({
      requestId: "req-1",
      state: "running",
      startedAt: "2026-08-04T09:00:00Z",
    });
    expect(cellSignalRefreshView(facts({ pendingRequestId: "req-1", run })).kind).toBe("running");
  });

  it("carries the failure text through verbatim", () => {
    const run = readStatusFile({
      requestId: "req-1",
      state: "failed",
      finishedAt: "2026-08-04T11:00:00Z",
      error: "FCC returned 401 Unauthorized",
    });
    const view = cellSignalRefreshView(facts({ pendingRequestId: "req-1", run }));
    expect(view.kind).toBe("failed");
    expect(view.detail).toContain("FCC returned 401 Unauthorized");
    expect(view.tone).toBe("warn");
  });

  it("says a run finished without claiming the data changed", () => {
    // The FCC publishes twice a year; a run that found nothing new succeeded.
    // The archive's age is the coverage line's business, not this one's.
    const run = readStatusFile({
      requestId: "req-1",
      state: "succeeded",
      finishedAt: "2026-08-04T11:00:00Z",
    });
    const view = cellSignalRefreshView(facts({ pendingRequestId: "req-1", run }));
    expect(view.kind).toBe("succeeded");
    expect(view.detail).not.toMatch(/updated|new data|current/i);
    expect(view.canRequest).toBe(true);
  });

  it("reports an interrupted run and offers a retry", () => {
    const run = readStatusFile({ requestId: "req-1", state: "interrupted" });
    const view = cellSignalRefreshView(facts({ pendingRequestId: "req-1", run }));
    expect(view.kind).toBe("interrupted");
    expect(view.canRequest).toBe(true);
  });

  it("is idle when set up and nothing has been asked for", () => {
    expect(cellSignalRefreshView(facts()).kind).toBe("idle");
  });

  it("reads the clock from its argument, never from the system", () => {
    const run = readStatusFile({ requestId: "req-1", state: "running", heartbeatAt: "2026-08-04T11:59:00Z" });
    const base = facts({ pendingRequestId: "req-1", run });
    expect(cellSignalRefreshView(base).kind).toBe("running");
    // Same run file, later clock, with an agent still checking in: the
    // identical status now means the run died rather than that it is slow.
    const later = {
      ...base,
      now: "2026-08-04T14:00:00Z",
      watcher: readWatcherFile({ aliveAt: "2026-08-04T13:59:00Z", pollSeconds: 300 }),
    };
    expect(cellSignalRefreshView(later).kind).toBe("interrupted");
  });

  it("blames the agent, not the run, when both went quiet together", () => {
    // They share a cause — the agent writes both heartbeats from one loop — so
    // reporting the run as interrupted would send the operator to Task
    // Scheduler when the real answer is that nothing is polling at all.
    const run = readStatusFile({ requestId: "req-1", state: "running", heartbeatAt: "2026-08-04T09:00:00Z" });
    const view = cellSignalRefreshView(
      facts({
        pendingRequestId: "req-1",
        run,
        watcher: readWatcherFile({ aliveAt: "2026-08-04T09:00:00Z", pollSeconds: 300 }),
      }),
    );
    expect(view.kind).toBe("agent-stale");
  });

  it("survives unparseable timestamps without throwing or claiming success", () => {
    const bent = readWatcherFile({ aliveAt: "last Tuesday", pollSeconds: 300 });
    const view = cellSignalRefreshView(facts({ watcher: bent }));
    expect(view.kind).toBe("agent-stale");
    expect(view.tone).toBe("warn");
  });

  it("blocks a new request in exactly the states where one would be wrong", () => {
    // Asserted as a set so a state added later has to make this decision
    // deliberately rather than inheriting a default.
    const blocked: RefreshKind[] = ["no-credentials", "not-exported", "queued", "running"];
    const cases: [RefreshKind, RefreshFacts][] = [
      ["no-credentials", facts({ hasCredentials: false })],
      ["not-exported", facts({ tokenExported: false })],
      ["no-agent", facts({ watcher: null })],
      ["agent-stale", facts({ watcher: readWatcherFile({ aliveAt: "2026-08-04T09:00:00Z" }) })],
      ["queued", facts({ pendingRequestId: "req-1" })],
      [
        "running",
        facts({
          pendingRequestId: "req-1",
          run: readStatusFile({ requestId: "req-1", state: "running", heartbeatAt: "2026-08-04T11:59:00Z" }),
        }),
      ],
      [
        "succeeded",
        facts({ pendingRequestId: "req-1", run: readStatusFile({ requestId: "req-1", state: "succeeded" }) }),
      ],
      [
        "failed",
        facts({ pendingRequestId: "req-1", run: readStatusFile({ requestId: "req-1", state: "failed" }) }),
      ],
      [
        "interrupted",
        facts({ pendingRequestId: "req-1", run: readStatusFile({ requestId: "req-1", state: "interrupted" }) }),
      ],
      ["idle", facts()],
    ];
    for (const [expected, input] of cases) {
      const view = cellSignalRefreshView(input);
      expect(view.kind).toBe(expected);
      expect(view.canRequest).toBe(!blocked.includes(expected));
    }
  });
});
