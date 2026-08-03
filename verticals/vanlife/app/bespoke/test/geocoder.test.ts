/**
 * Place lookup: the User-Agent, the memory, and the difference between
 * "no such place" and "no uplink".
 *
 * These are the three things that made the lookup worth moving off the client.
 * All three fail quietly if they regress — a dropped header looks like a flaky
 * endpoint, a broken cache looks like a slow one, and an error collapsed into
 * an empty list looks like the place simply does not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { placeLookups } from "../src/db/schema.js";
import {
  radiusFromBbox,
  resetGeocoderGate,
  reverseKey,
  reversePlace,
  searchKey,
  searchPlaces,
} from "../src/server/engine/geocoder.js";

const BISHOP = { lat: 37.3634, lng: -118.3951 };

/** One Nominatim /search row, shaped as the real endpoint shapes it. */
const BISHOP_ROW = {
  display_name: "Bishop, Inyo County, California, United States",
  lat: "37.3634",
  lon: "-118.3951",
  boundingbox: ["37.3434", "37.3834", "-118.4151", "-118.3751"] as [string, string, string, string],
};

let handle: DbHandle;

async function migrate(h: DbHandle): Promise<void> {
  const md = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  for (const f of fs.readdirSync(md).filter((x) => x.endsWith(".sql")).sort())
    for (const s of fs.readFileSync(path.join(md, f), "utf8").split("--> statement-breakpoint"))
      if (s.trim()) await h.client.execute(s);
}

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(async () => {
  handle = await createDb({ dbFile: ":memory:" });
  await migrate(handle);
  resetGeocoderGate();
});

afterEach(() => {
  handle.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("place search", () => {
  it("sends an identifying User-Agent", async () => {
    // The reason this runs on the server at all: a browser cannot set this
    // header, and the OSM endpoints refuse anonymous clients.
    const fetchMock = vi.fn(async () => okJson([BISHOP_ROW]));
    vi.stubGlobal("fetch", fetchMock);

    await searchPlaces(handle.db, "Bishop");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/dilly-dally/);
  });

  it("remembers an answer, and a repeat query makes no network call", async () => {
    const fetchMock = vi.fn(async () => okJson([BISHOP_ROW]));
    vi.stubGlobal("fetch", fetchMock);

    const first = await searchPlaces(handle.db, "Bishop");
    expect(first.hits).toHaveLength(1);
    expect(first.stale).toBe(false);

    const second = await searchPlaces(handle.db, "  BISHOP  "); // same place, sloppier typing
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.hits[0]!.name).toBe(BISHOP_ROW.display_name);
    expect(second.stale).toBe(false);

    const rows = await handle.db.select().from(placeLookups);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("search");
  });

  it("serves a remembered answer when the lookup fails, and says it is stale", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson([BISHOP_ROW])));
    await searchPlaces(handle.db, "Bishop");

    // Age the row past the freshness window so the next call goes to the network.
    await handle.client.execute("UPDATE place_lookups SET fetched_at = '2020-01-01T00:00:00.000Z'");
    resetGeocoderGate();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND nominatim.openstreetmap.org");
      }),
    );

    const offline = await searchPlaces(handle.db, "Bishop");
    expect(offline.hits).toHaveLength(1);
    expect(offline.stale).toBe(true);
    // Not an error: we have a real answer, it is just an old one.
    expect(offline.error).toBeNull();
  });

  it("reports an unreachable lookup as an error, not as an empty result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await searchPlaces(handle.db, "Nowhere In Particular");
    expect(result.hits).toEqual([]);
    expect(result.error).toBe("network down");
    expect(result.stale).toBe(false);
  });

  it("distinguishes a genuine no-match from an outage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson([])));

    const result = await searchPlaces(handle.db, "Zzzzzqqq Township");
    expect(result.hits).toEqual([]);
    expect(result.error).toBeNull(); // the place does not exist; the uplink is fine
  });

  it("does not call out for a query too short to mean anything", async () => {
    const fetchMock = vi.fn(async () => okJson([BISHOP_ROW]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchPlaces(handle.db, "Bi");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.hits).toEqual([]);
    expect(result.error).toBeNull();
  });

  it("spaces consecutive outbound calls by at least a second", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson([BISHOP_ROW])));

    const started = Date.now();
    await Promise.all([searchPlaces(handle.db, "Bishop"), searchPlaces(handle.db, "Lone Pine")]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });
});

describe("reverse lookup", () => {
  it("names a fix and remembers it", async () => {
    const fetchMock = vi.fn(async () => okJson(BISHOP_ROW)); // /reverse answers with one object
    vi.stubGlobal("fetch", fetchMock);

    const first = await reversePlace(handle.db, BISHOP);
    expect(first.name).toBe(BISHOP_ROW.display_name);
    expect(first.error).toBeNull();

    // A few metres of GPS jitter within the bucket is the same place.
    const again = await reversePlace(handle.db, { lat: BISHOP.lat - 0.0003, lng: BISHOP.lng + 0.0003 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.name).toBe(BISHOP_ROW.display_name);
  });

  it("returns no name rather than throwing when the lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const result = await reversePlace(handle.db, BISHOP);
    expect(result.name).toBeNull();
    expect(result.error).toBe("offline");
    // The caller still holds a perfectly good fix — naming it is the optional part.
  });
});

describe("keys and radius", () => {
  it("normalizes whitespace and case into one search key", () => {
    expect(searchKey("  Eastern   SIERRA ")).toBe("eastern sierra");
  });

  it("keys reverse lookups into ~110m buckets so a jittering fix reuses one row", () => {
    expect(reverseKey(BISHOP)).toBe("37.363,-118.395");
    // Jitter inside the bucket collapses to the same key...
    expect(reverseKey({ lat: BISHOP.lat - 0.0003, lng: BISHOP.lng })).toBe(reverseKey(BISHOP));
    // ...and jitter across a bucket edge honestly does not. Buckets are not
    // radii; the cost is one extra lookup, which is then cached too.
    expect(reverseKey({ lat: BISHOP.lat + 0.0002, lng: BISHOP.lng })).not.toBe(reverseKey(BISHOP));
  });

  it("suggests the same radius the client used to compute, so Target radii do not shift", () => {
    // Half the diagonal of the bbox, clamped to [5, 400].
    expect(radiusFromBbox(BISHOP_ROW.boundingbox, 37.3634)).toBe(5);
    expect(radiusFromBbox(undefined, 37.3634)).toBe(25);
    expect(radiusFromBbox(["30", "40", "-120", "-110"], 35)).toBe(400);
  });
});
