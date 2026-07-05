import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const common = resolve('src/common')

// A header-based CSP does not apply to file:// (how the packaged app loads), so inject a strict
// policy as a <meta> tag - but only in the production build, so Vite's dev HMR is unaffected.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
  "base-uri 'self'; form-action 'self'; object-src 'none'"

function injectCsp(): Plugin {
  return {
    name: 'jarvis-inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `  <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  </head>`
      )
    }
  }
}

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
    plugins: [react(), injectCsp()]
  }
})
