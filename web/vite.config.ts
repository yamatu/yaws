import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/ws": {
        target: "http://localhost:3001",
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("error", (err: any) => {
            if (err?.code === "ECONNRESET" || err?.code === "EPIPE") return;
            // eslint-disable-next-line no-console
            console.error("[vite ws proxy] error", err);
          });
        },
      },
      "/health": "http://localhost:3001",
    },
  },
});
