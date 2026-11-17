import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(import.meta.dirname, 'src/shared') }

// Every runtime dependency is bundled, so the packaged app ships no node_modules
// and needs no native rebuild (SQLite comes from Electron's built-in node:sqlite).
export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: { externalizeDeps: false, sourcemap: true }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      externalizeDeps: false,
      // Sandboxed preload scripts must be a single CommonJS file.
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } }
    }
  },
  renderer: {
    resolve: { alias: shared },
    plugins: [react()],
    build: { sourcemap: false }
  }
})
