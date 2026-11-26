import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves this project from the /nth-stroke/ subpath
  base: '/nth-stroke/',
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
  },
});
