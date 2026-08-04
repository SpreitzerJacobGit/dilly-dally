/**
 * Writing the FCC credentials where the host refresh can read them.
 *
 * This is the one path in the app where a mistake publishes a secret. The tile
 * volume is served at /tiles/ and its status route parses and returns every
 * *.json beside the archives, unauthenticated — so a token that lands there is
 * handed to anyone who can reach the van's wifi. These tests use a real
 * filesystem rather than a mock precisely because the mistakes worth catching
 * are filesystem mistakes: the wrong directory, a mode nobody set, a temp file
 * nobody cleaned up.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportFccToken,
  exportedTokenUsername,
  fccTokenPath,
  readStateJson,
  refreshRequestPath,
  removeFccToken,
  writeStateJson,
} from "../src/server/engine/cellSignal.js";

let root: string;
const savedEnv = { STATE_DIR: process.env.STATE_DIR, TILES_DIR: process.env.TILES_DIR };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vl-token-"));
  process.env.STATE_DIR = path.join(root, "data");
  process.env.TILES_DIR = path.join(root, "data", "tiles");
  fs.mkdirSync(process.env.TILES_DIR, { recursive: true });
});

afterEach(() => {
  process.env.STATE_DIR = savedEnv.STATE_DIR;
  process.env.TILES_DIR = savedEnv.TILES_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

const creds = { username: "jacob@example.com", token: "s3cret-token" };

describe("exportFccToken", () => {
  it("writes exactly the two keys the PowerShell parser reads", () => {
    exportFccToken(creds, "2026-08-04T12:00:00Z");
    const parsed = JSON.parse(fs.readFileSync(fccTokenPath(), "utf8")) as Record<string, unknown>;
    // Get-FccAuthHeaders reads .username and .token and nothing else. savedAt is
    // for a human reading the file; anything beyond these three would be a field
    // the host silently ignores.
    expect(Object.keys(parsed).sort()).toEqual(["savedAt", "token", "username"]);
    expect(parsed.username).toBe(creds.username);
    expect(parsed.token).toBe(creds.token);
  });

  it("creates the channel directory on first save", () => {
    // /data is a volume mount that always exists; the cell-signal subdirectory
    // is ours to make, and a first save must not fail for want of it.
    expect(fs.existsSync(path.dirname(fccTokenPath()))).toBe(false);
    exportFccToken(creds, "2026-08-04T12:00:00Z");
    expect(fs.existsSync(fccTokenPath())).toBe(true);
  });

  it.skipIf(process.platform === "win32")("writes owner-only, not world-readable", () => {
    exportFccToken(creds, "2026-08-04T12:00:00Z");
    expect(fs.statSync(fccTokenPath()).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind", () => {
    exportFccToken(creds, "2026-08-04T12:00:00Z");
    // A .tmp holding the token would be a second copy with no lifecycle and
    // nobody's attention on it.
    expect(fs.readdirSync(path.dirname(fccTokenPath()))).toEqual(["fcc-token.json"]);
  });

  it("replaces rather than appends when saved again", () => {
    exportFccToken(creds, "2026-08-04T12:00:00Z");
    exportFccToken({ username: "partner@example.com", token: "other" }, "2026-08-05T12:00:00Z");
    expect(exportedTokenUsername()).toBe("partner@example.com");
  });

  it("refuses to write anywhere the tile server would publish it", () => {
    // The guard, and the reason this file exists. Point the channel at the
    // served directory and the write must fail rather than succeed quietly.
    process.env.STATE_DIR = process.env.TILES_DIR;
    expect(() => exportFccToken(creds, "2026-08-04T12:00:00Z")).toThrow(/served publicly/);
    expect(fs.readdirSync(process.env.TILES_DIR!)).toEqual([]);
  });

  it("refuses even when the path reaches the tile directory the long way round", () => {
    process.env.STATE_DIR = path.join(root, "data", "tiles", "..", "tiles", "sub");
    expect(() => exportFccToken(creds, "2026-08-04T12:00:00Z")).toThrow(/served publicly/);
  });
});

describe("removeFccToken", () => {
  it("removes the file", () => {
    exportFccToken(creds, "2026-08-04T12:00:00Z");
    removeFccToken();
    expect(fs.existsSync(fccTokenPath())).toBe(false);
  });

  it("treats an already-absent token as done, not as a failure", () => {
    // Clearing credentials that were never exported is the desired end state.
    expect(() => removeFccToken()).not.toThrow();
  });
});

describe("exportedTokenUsername", () => {
  it("reports what is on disk rather than what was last written", () => {
    exportFccToken(creds, "2026-08-04T12:00:00Z");
    // The volume can be wiped by `docker compose down -v` between the save and
    // the question. Remembering the write would claim a file that is gone.
    fs.rmSync(fccTokenPath());
    expect(exportedTokenUsername()).toBeNull();
  });

  it("reads a half-written file as absent rather than throwing", () => {
    fs.mkdirSync(path.dirname(fccTokenPath()), { recursive: true });
    fs.writeFileSync(fccTokenPath(), '{"username": "jac');
    expect(exportedTokenUsername()).toBeNull();
  });
});

describe("writeStateJson / readStateJson", () => {
  it("round-trips a refresh request", () => {
    const request = { schema: 1, requestId: "abc", requestedAt: "2026-08-04T12:00:00Z", force: false };
    writeStateJson(refreshRequestPath(), request);
    expect(readStateJson(refreshRequestPath())).toEqual(request);
  });

  it("reads a missing file as null", () => {
    expect(readStateJson(refreshRequestPath())).toBeNull();
  });

  it("ignores a file too large to be one of ours", () => {
    // The host writes a few hundred bytes. An unbounded read behind a status
    // query is how a status endpoint becomes the outage.
    fs.mkdirSync(path.dirname(refreshRequestPath()), { recursive: true });
    fs.writeFileSync(refreshRequestPath(), `{"pad":"${"x".repeat(70 * 1024)}"}`);
    expect(readStateJson(refreshRequestPath())).toBeNull();
  });
});
