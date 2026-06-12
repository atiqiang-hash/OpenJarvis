import { defineConfig } from 'vite';

// NABILA frontend dev server.
//
// Handoff §2: browser (localhost:5555) -> /api/* proxy -> FastAPI backend (port 8001).
// Handoff §10: keep `open: false` — the restart-v0.x.command script already opens the
// browser, so letting Vite open another tab causes the double-tab bug.
export default defineConfig({
  server: {
    port: 5555,
    open: false,
    proxy: {
      '/api': process.env.NABILA_API_URL || 'http://localhost:8001',
    },
  },
});
