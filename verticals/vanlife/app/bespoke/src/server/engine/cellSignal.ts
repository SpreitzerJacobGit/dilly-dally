/**
 * FCC credentials and the file channel to the host refresh agent.
 *
 * The cell signal overlay is built by PowerShell on the van server — ~78
 * rate-limited FCC downloads, GDAL and tippecanoe — and this container has no
 * Docker socket and no view of the repo. So the app owns the credentials and
 * the asking; the host owns the doing. They talk through files on the one
 * private volume they share, because a file channel keeps working when either
 * side is down, and there is no socket, port or daemon to keep alive.
 *
 * The protocol is documented in deploy/README.md and implemented on the other
 * side by deploy/watch-cell-signal.ps1. Four files in /data/cell-signal:
 * fcc-token.json and request.json are written here, status.json and
 * watcher.json are written by the host.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type Db } from "@elements/storage-sqlite-drizzle";
import { deleteSetting, getSetting } from "@elements/lifecycle-app-settings";

/** Operator-set FCC Broadband Data Collection credentials. */
export const CELL_SIGNAL_SETTINGS_KEY = "cell-signal";
export const CellSignalSettingsSchema = z.object({
  username: z.string().min(1).max(200),
  token: z.string().min(1).max(500),
});
export type CellSignalCredentials = z.infer<typeof CellSignalSettingsSchema>;

/**
 * Deliberately no DEFAULT_ constant, unlike the planning and digest settings.
 * An absent drive-hours setting wants a stand-in value; absent credentials are
 * a real state with real consequences, and the page says so rather than
 * pretending to a default nobody chose.
 */
export async function cellSignalCredentials(db: Db): Promise<CellSignalCredentials | null> {
  const rec = await getSetting(db, CELL_SIGNAL_SETTINGS_KEY, CellSignalSettingsSchema);
  return rec?.value ?? null;
}

export async function clearCellSignalCredentials(db: Db): Promise<void> {
  await deleteSetting(db, CELL_SIGNAL_SETTINGS_KEY);
}

/**
 * The vanlife-data volume as seen from inside the container.
 *
 * Read from the environment here rather than handed down, because there is
 * nowhere to hand it down from: ctx is {dbHandle, logger, cookies} and the
 * routers are module constants built at import time, before boot. engine/osrm.ts
 * reads OSRM_URL the same way for the same reason.
 *
 * Functions rather than module constants so a test can point STATE_DIR at a
 * temp directory. That matters more here than anywhere else in the app — this
 * is the one path where a mistake publishes a credential.
 *
 * Deliberately not path.dirname(DB_FILE), which happens to be /data in the
 * container today but in dev is a scratch path the token would silently follow
 * into the repo.
 */
function stateDir(): string {
  return process.env.STATE_DIR ?? "/data";
}

function tilesDir(): string {
  return path.resolve(process.env.TILES_DIR ?? "/data/tiles");
}

/** Everything this module owns lives together, so the host has one directory to poll. */
function channelDir(): string {
  return path.join(stateDir(), "cell-signal");
}

export function fccTokenPath(): string {
  return path.join(channelDir(), "fcc-token.json");
}

export function refreshRequestPath(): string {
  return path.join(channelDir(), "request.json");
}

export function refreshStatusPath(): string {
  return path.join(channelDir(), "status.json");
}

export function watcherPath(): string {
  return path.join(channelDir(), "watcher.json");
}

/**
 * The tile plugin serves TILES_DIR at /tiles/ and its /tiles/status route
 * parses and returns every *.json sitting in it, unauthenticated. A credential
 * written there would be handed to anyone who can reach the van's wifi. This
 * is the guard against that, and it is checked on every write rather than
 * trusted to the path helpers above staying correct.
 */
function assertNotPublic(target: string): void {
  const rel = path.relative(tilesDir(), path.resolve(target));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(`refusing to write ${target}: ${tilesDir()} is served publicly`);
  }
}

/**
 * Write JSON where the host can read it, atomically.
 *
 * tmp-then-rename because the host polls these files on a schedule of its own
 * and must never read half of one — the same reason refresh-cell-signal.ps1
 * installs the archive with cp-then-mv while the server is serving byte ranges
 * out of it.
 *
 * Throws rather than returning a boolean. A caller that cannot write the token
 * has not configured anything, and saying so is the whole point.
 */
export function writeStateJson(target: string, value: unknown): void {
  assertNotPublic(target);
  const dir = path.dirname(target);
  // Created if absent: /data is a volume mount that always exists in the
  // container, but the cell-signal subdirectory is ours to make on first save.
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  // writeFileSync's mode is masked by umask; chmod is not. Windows ignores it,
  // which is fine — this only runs for real inside the Linux container.
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
}

/**
 * Read one of the host's files. Anything unreadable — absent, half-written,
 * not JSON — is null, because the caller's job is to report "the host has not
 * answered", and a parse error here is indistinguishable from that.
 */
export function readStateJson(target: string): unknown {
  try {
    // The host writes a few hundred bytes. Anything larger is not our file and
    // parsing it would put an unbounded read behind a status query.
    if (fs.statSync(target).size > 64 * 1024) return null;
    return JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Hand the credentials to the host.
 *
 * Same key names as the repo-root .fcc-token the script has always read, so
 * one parser in refresh-cell-signal.ps1 handles both sources. savedAt is
 * ignored by the script and exists so a human can tell an app-written file
 * from a hand-made one.
 */
export function exportFccToken(creds: CellSignalCredentials, nowIso: string): void {
  writeStateJson(fccTokenPath(), {
    username: creds.username,
    token: creds.token,
    savedAt: nowIso,
  });
}

export function removeFccToken(): void {
  try {
    fs.unlinkSync(fccTokenPath());
  } catch (err) {
    // Already gone is the desired end state, not a failure. Anything else is
    // a token we failed to remove, which is the entire risk this guards.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * What is actually on the volume right now — never what we remember writing.
 *
 * A remembered success is exactly the claim this app refuses to make: the
 * volume can be wiped by `docker compose down -v` between the save and the
 * question, and the operator needs to know that before a scheduled refresh
 * fails at 03:30 on a Sunday.
 */
export function exportedTokenUsername(): string | null {
  const raw = readStateJson(fccTokenPath());
  if (raw === null || typeof raw !== "object") return null;
  const username = (raw as Record<string, unknown>).username;
  return typeof username === "string" && username.length > 0 ? username : null;
}

export const FCC_LIST_DATES_URL = "https://broadbandmap.fcc.gov/api/public/map/listAsOfDates";

export type FccProbe = { ok: true; asOfDate: string | null } | { ok: false; error: string };

/**
 * Confirm the credentials by using them, on the cheapest call the API has.
 *
 * Returns a result rather than throwing, so a rejected token reads as an
 * answer — the same shape ntfy's testPublish uses.
 *
 * Note the endpoint and header names are UNVERIFIED, exactly as
 * refresh-cell-signal.ps1 says of its own copies: the FCC spec is behind an
 * edge filter that refuses scripted fetches. A 404 from a wrong path is
 * therefore indistinguishable from a rejected token, which is why the caller's
 * copy must say "could not confirm" and never "your credentials are wrong".
 */
export async function probeFccCredentials(db: Db): Promise<FccProbe> {
  const creds = await cellSignalCredentials(db);
  if (creds === null) return { ok: false, error: "No credentials stored." };
  try {
    const res = await fetch(FCC_LIST_DATES_URL, {
      headers: { username: creds.username, hash_value: creds.token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `FCC returned ${String(res.status)} ${res.statusText}` };
    const body = (await res.json()) as { data?: { as_of_date?: string }[] };
    const dates = (body.data ?? [])
      .map((d) => d.as_of_date)
      .filter((d): d is string => typeof d === "string")
      .sort();
    return { ok: true, asOfDate: dates.at(-1) ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
