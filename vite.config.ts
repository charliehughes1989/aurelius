import { defineConfig } from 'vite';

export default defineConfig({
  root: 'public',
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
