import type { DbHandle } from "@elements/storage-sqlite-drizzle";
import type { AppLogger } from "@elements/observability-structured-logging";

export interface Cookies {
  get(name: string): string | undefined;
  set(name: string, value: string, opts?: { maxAgeSeconds?: number }): void;
  clear(name: string): void;
}

/**
 * The request context every procedure in every element and bespoke layer sees.
 * Elements that need more (e.g. identity's user) extend it via middleware.
 */
export interface BaseContext {
  dbHandle: DbHandle;
  logger: AppLogger;
  cookies: Cookies;
}
