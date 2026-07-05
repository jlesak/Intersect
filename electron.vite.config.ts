import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const common = resolve('src/common')

// node:sqlite is a Node built-in (auto-external). node-pty is a runtime `dependency`,
// which electron-vite v5 externalizes automatically for the main build - a native
// .node addon must never be bundled by Rollup.
export default defineConfig({
  main: {
    resolve: { alias: { '@common': common } }
  },
  preload: {
    resolve: { alias: { '@common': common } }
  },
  renderer: {
    resolve: {
      alias: {
        '@common': common,
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
