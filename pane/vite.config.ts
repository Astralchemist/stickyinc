import { defineConfig } from "vite";
import { resolve } from "node:path";

// Tauri expects a fixed port and no HMR over host 0.0.0.0
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        quickadd: resolve(__dirname, "quickadd.html"),
        wizard: resolve(__dirname, "wizard.html"),
      },
    },
  },
});
