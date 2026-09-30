import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing libraries into their own chunks. They
        // cache across deploys, so shipping a UI tweak no longer forces a browser
        // to re-download ethers and the charting library.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          ethers: ['ethers'],
          charts: ['recharts'],
        },
      },
    },
  },
});
