import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig(({ mode }) => {
  // The checkout keeps .env at the repository root. The Docker image only
  // contains the frontend under /app, so Compose supplies COURSE_FOREST_ENV_DIR
  // and VITE_* variables instead.
  const envDir = process.env.COURSE_FOREST_ENV_DIR || path.resolve(__dirname, "../..");
  const env = loadEnv(mode, envDir, "VITE_");
  const backendUrl = env.VITE_API_URL || "http://127.0.0.1:8000";

  return {
    envDir,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: backendUrl,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
