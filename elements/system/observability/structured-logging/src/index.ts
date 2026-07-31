import { pino, type Logger } from "pino";

export type AppLogger = Logger;

export interface LogEntry {
  time: string;
  level: string;
  msg: string;
  [key: string]: unknown;
}

/**
 * Keeps the most recent warn/error entries in memory so the health element can
 * expose them — the only window into infrastructure that cannot be inspected.
 */
export class LogRingBuffer {
  private readonly entries: LogEntry[] = [];
  constructor(private readonly capacity: number = 200) {}

  push(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  recent(count = 50): LogEntry[] {
    return this.entries.slice(-count);
  }
}

export interface CreateLoggerOptions {
  level?: string;
  /** Service name stamped on every line. */
  name: string;
  ringBuffer?: LogRingBuffer;
}

const LEVEL_NAMES: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export function createLogger(opts: CreateLoggerOptions): AppLogger {
  const ring = opts.ringBuffer;
  const logger = pino({
    name: opts.name,
    level: opts.level ?? "info",
    // pino rejects an explicit `hooks: undefined` — only set the key when used.
    ...(ring
      ? {
          hooks: {
            logMethod(
              this: unknown,
              args: Parameters<AppLogger["info"]>,
              method: (...a: Parameters<AppLogger["info"]>) => void,
              level: number,
            ) {
              if (level >= 40) {
                const first = args[0];
                const msg =
                  typeof first === "string"
                    ? first
                    : typeof args[1] === "string"
                      ? args[1]
                      : JSON.stringify(first);
                ring.push({
                  time: new Date().toISOString(),
                  level: LEVEL_NAMES[level] ?? String(level),
                  msg,
                });
              }
              method.apply(this, args);
            },
          },
        }
      : {}),
  });
  return logger;
}

export function childLogger(parent: AppLogger, bindings: Record<string, unknown>): AppLogger {
  return parent.child(bindings);
}

/** Serialize an unknown error into loggable shape. */
export function errorInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}
