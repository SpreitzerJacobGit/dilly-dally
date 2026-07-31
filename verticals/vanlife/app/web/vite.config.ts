// GENERATED FROM assembly.manifest.yaml — DO NOT EDIT
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/trpc": "http://localhost:18081" },
  },
  build: { outDir: "dist" },
});
