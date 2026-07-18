import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const common = resolve('src/common')

// A header-based CSP does not apply to file:// (how the packaged app loads), so inject a strict
// policy as a <meta> tag - but only in the production build, so Vite's dev HMR is unaffected.
// worker-src allows Monaco's bundled ES-module workers (script-src stays 'self').
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; " +
  "base-uri 'self'; form-action 'self'; object-src 'none'"

function injectCsp(): Plugin {
  return {
    name: 'intersect-inject-csp',
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
    resolve: { alias: { '@common': common } },
    // Bundle the MCP SDK (ESM-only) into the CJS main outputs so a plain `node` running the draft
    // server resolves it without ESM/CJS friction; node-pty stays external (native addon).
    plugins: [externalizeDepsPlugin({ exclude: ['@modelcontextprotocol/sdk'] })],
    build: {
      rollupOptions: {
        // Extra entries: the headless core (forked as an Electron utilityProcess) and the
        // standalone MCP servers (draft review, jira report, 1:1 report) that guardrailed
        // claude sessions spawn under plain node. All land in out/main so the core can
        // resolve its sibling server scripts via __dirname.
        input: {
          index: resolve('src/main/index.ts'),
          core: resolve('src/core/index.ts'),
          draftServer: resolve('src/core/prInbox/draftServer.ts'),
          jiraReportServer: resolve('src/core/myWork/jiraReportServer.ts'),
          otoReportServer: resolve('src/core/oneOnOne/otoReportServer.ts'),
          hookHelper: resolve('src/core/hooks/intersectHook.ts')
        }
      }
    }
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
    // Monaco's language/diff workers are emitted as same-origin ES-module chunks.
    worker: { format: 'es' },
    plugins: [react(), injectCsp()]
  }
})
