import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The app talks to /api on its own origin in every environment; in dev that
    // is proxied to the API server so there is no CORS setup to get wrong.
    proxy: { '/api': 'http://localhost:4000' },
  },
});
