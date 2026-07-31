// GENERATED FROM assembly.manifest.yaml — DO NOT EDIT
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "../../db/migrations",
});
