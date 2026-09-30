import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, ".github/extensions/agentcorp-observer/viewer"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "observe.html") },
  },
});
