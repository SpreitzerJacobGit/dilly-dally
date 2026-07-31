// GENERATED FROM assembly.manifest.yaml — DO NOT EDIT
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node22",
  outExtension: () => ({ js: ".js" }),
  noExternal: [/.*/],
  external: ["@libsql/client"],
  clean: true,
});
