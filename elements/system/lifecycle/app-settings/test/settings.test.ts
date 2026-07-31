import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createDb, type DbHandle } from "@elements/storage-sqlite-drizzle";
import { getSetting, setSetting, deleteSetting } from "../src/index.js";

async function testDb(): Promise<DbHandle> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agger-settings-"));
  const handle = await createDb({ dbFile: path.join(dir, "test.db") });
  await handle.client.execute(
    `CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL)`,
  );
  return handle;
}

const schema = z.object({ url: z.string(), retries: z.number().int() });

describe("app-settings", () => {
  it("round-trips a validated setting with updatedAt, and overwrites in place", async () => {
    const handle = await testDb();
    expect(await getSetting(handle.db, "svc", schema)).toBeNull();

    await setSetting(handle.db, "svc", schema, { url: "https://a", retries: 2 }, "user:1");
    const first = await getSetting(handle.db, "svc", schema);
    expect(first?.value).toEqual({ url: "https://a", retries: 2 });
    expect(first?.updatedAt).toBeTruthy();

    await new Promise((r) => setTimeout(r, 5));
    await setSetting(handle.db, "svc", schema, { url: "https://b", retries: 5 }, "user:2");
    const second = await getSetting(handle.db, "svc", schema);
    expect(second?.value).toEqual({ url: "https://b", retries: 5 });
    expect(second!.updatedAt >= first!.updatedAt).toBe(true);
    handle.close();
  });

  it("throws loudly on corrupted or schema-invalid records — never a silent 'unconfigured'", async () => {
    const handle = await testDb();
    await handle.client.execute(
      `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('bad-json', '{oops', 'x', 'now')`,
    );
    await handle.client.execute(
      `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('bad-shape', '{"url": 5}', 'x', 'now')`,
    );
    await expect(getSetting(handle.db, "bad-json", schema)).rejects.toThrow(/corrupted/);
    await expect(getSetting(handle.db, "bad-shape", schema)).rejects.toThrow(/does not match/);
    handle.close();
  });

  it("rejects invalid writes and deletes cleanly", async () => {
    const handle = await testDb();
    await expect(
      setSetting(handle.db, "svc", schema, { url: "https://a", retries: 1.5 }, "user:1"),
    ).rejects.toThrow();
    await setSetting(handle.db, "svc", schema, { url: "https://a", retries: 1 }, null);
    await deleteSetting(handle.db, "svc");
    expect(await getSetting(handle.db, "svc", schema)).toBeNull();
    handle.close();
  });
});
