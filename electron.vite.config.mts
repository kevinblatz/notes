import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

const shared = { '@shared': resolve(import.meta.dirname, 'src/shared') }

/**
 * Content Security Policy for the packaged window: only the app's own scripts, styles and
 * fonts, plus images from the managed attachments folder. No remote origins at all.
 * (Not applied in development, where the dev server needs inline scripts for hot reload.)
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' tn-attachment: blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-src 'none'"
].join('; ')

const contentSecurityPolicy = (): Plugin => ({
  name: 'trading-notes-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
})

// Every runtime dependency is bundled, so the packaged app ships no node_modules and needs
// no native rebuild (SQLite comes from Electron's built-in node:sqlite).
export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: { externalizeDeps: false, minify: true }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      externalizeDeps: false,
      minify: true,
      // A sandboxed preload script must be a single CommonJS file.
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } }
    }
  },
  renderer: {
    resolve: { alias: shared },
    plugins: [react(), contentSecurityPolicy()],
    build: { minify: true }
  }
})
