import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const configuredPort = Number.parseInt(process.env.VITE_PORT ?? '5173', 10);
const devPort = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65_536 ? configuredPort : 5173;

export default defineConfig({
  plugins: [react()],
  base: './',
  root: 'src/renderer',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: true,
  },
});
