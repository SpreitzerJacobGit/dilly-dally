import { z, type ZodObject, type ZodRawShape } from "zod";

export class ConfigError extends Error {
  public readonly issues: string[];
  constructor(issues: string[]) {
    super(`Configuration invalid:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Parse environment variables against a zod schema and fail fast at boot with a
 * precise report of every missing or invalid key. Schema keys are env var names.
 */
export function loadConfig<S extends ZodRawShape>(
  schema: ZodObject<S>,
  env: Record<string, string | undefined> = process.env,
): z.infer<ZodObject<S>> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      return `${key}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }
  return result.data;
}

/** Common env field shapes. */
export function envString() {
  return z.string().min(1);
}
export function envInt() {
  return z.coerce.number().int();
}
export function envBool() {
  return z
    .enum(["true", "false"])
    .transform((v) => v === "true");
}
