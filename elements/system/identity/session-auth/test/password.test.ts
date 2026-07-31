import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/password.js";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", () => {
    const stored = hashPassword("owner-demo-2026");
    expect(verifyPassword("owner-demo-2026", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  it("produces unique salts", () => {
    expect(hashPassword("x")).not.toBe(hashPassword("x"));
  });

  it("rejects malformed stored hashes", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
  });
});
