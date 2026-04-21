import { defineConfig } from "vite";

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
  },
});
