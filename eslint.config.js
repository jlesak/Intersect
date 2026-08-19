import tseslint from 'typescript-eslint'

const FEATURE_BOUNDARY = {
  group: ['@renderer/features/*/*'],
  message: 'Import another feature only through its index barrel (@renderer/features/<name>), never its internals.'
}

const NODE_PTY = {
  name: 'node-pty',
  message: 'node-pty may only be imported by src/core/pty/nodePtySpawn.ts - keeps the native binary out of Vitest and the renderer.'
}

// The core runs as an Electron utilityProcess: plain Node with no Electron APIs. Any
// `electron` import there would crash at runtime, so ban it statically.
const NO_ELECTRON_IN_CORE = {
  name: 'electron',
  message: 'src/core runs as a utilityProcess without Electron APIs. Native/OS work belongs in src/main behind the bridge.'
}

// Main must never re-acquire what the core owns: the database and PTY spawning. Reaching
// into the composition root would silently create a second owner.
const CORE_OWNERSHIP = [
  {
    group: ['**/core/db/connection', '**/core/bootstrap'],
    message: 'Only the core process opens the database and composes services. Talk to it over the port bridge.'
  }
]

// A selector that builds a fresh array or object makes the store snapshot unstable and React
// re-renders forever. Only stores built by the shared factory carry the guard that catches it.
const ZUSTAND_CREATE_MESSAGE =
  'Build renderer stores with createStore from @renderer/shared/store/createStore - it catches unstable selectors while developing.'

// Every way of reaching an unguarded store is banned, not just `create`. `zustand/vanilla` exports
// a `createStore` of its own, so an import completed from the wrong module would otherwise compile,
// lint, and quietly produce a store no selector check ever runs against.
const ZUSTAND_CREATE = [
  {
    name: 'zustand',
    importNames: ['create', 'createStore', 'useStore'],
    message: ZUSTAND_CREATE_MESSAGE
  },
  {
    name: 'zustand/react',
    importNames: ['create', 'useStore'],
    message: ZUSTAND_CREATE_MESSAGE
  },
  { name: 'zustand/vanilla', message: ZUSTAND_CREATE_MESSAGE },
  { name: 'zustand/traditional', message: ZUSTAND_CREATE_MESSAGE }
]

// The logger is the only sanctioned diagnostic surface: a console call writes to a stream nobody
// reads in a packaged app, and never reaches the log file.
const NO_CONSOLE = {
  'no-console': 'error'
}

// Reporting that the log sink itself is unusable cannot go through the logger that depends on it.
const SINK_FALLBACK_FILES = [
  'src/core/logging/index.ts',
  'src/main/logging/index.ts'
]

// The file sink opens a descriptor with node:fs. The renderer is sandboxed and preload runs in a
// sandboxed context, so an import there is a build-time bundling error waiting to happen.
const NODE_FILE_SINK = {
  group: ['**/logging/fileSink.node'],
  message: 'fileSink.node.ts is Node-only. The renderer ships log records to main over the preload bridge instead.'
}

// Every spec used to launch Electron itself, so one navigation change broke fifteen tests across
// separate files. Launching belongs to the harness alone.
const PLAYWRIGHT_ELECTRON = {
  name: '@playwright/test',
  importNames: ['_electron'],
  message: 'Launch the app via e2e/harness.ts so boot and navigation fixes land in one place.'
}

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'e2e-userdata/**',
      // Git worktrees of this repo checked out for parallel sessions. Their sources are linted in
      // their own checkout, and their build output would otherwise swamp every run from here.
      '.claude/worktrees/**',
      '_*.cjs',
      // Gitignored dev scratch specs: present locally, never part of the committed suite.
      'e2e/diag.spec.ts',
      'e2e/screenshot.spec.ts',
      '*.config.ts',
      '*.config.js'
    ]
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [NODE_PTY], patterns: [FEATURE_BOUNDARY] }]
    }
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: NO_CONSOLE
  },
  {
    files: SINK_FALLBACK_FILES,
    rules: {
      'no-console': 'off'
    }
  },
  {
    // The renderer mirror replaces the global console so that React, xterm and Monaco diagnostics
    // reach the log file. Reading and reassigning console is the mechanism itself.
    files: ['src/renderer/src/shared/logging/logger.ts'],
    rules: {
      'no-console': 'off'
    }
  },
  {
    // Tests never ship, and their output goes to a terminal somebody is watching. Several stub the
    // global console to prove that a diagnostic reached the log or that a render stayed quiet.
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'no-console': 'off'
    }
  },
  {
    files: ['src/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [NODE_PTY, NO_ELECTRON_IN_CORE], patterns: [FEATURE_BOUNDARY] }
      ]
    }
  },
  {
    files: ['src/main/**/*.{ts,tsx}', 'src/preload/**/*.{ts,tsx}', 'src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [NODE_PTY], patterns: [FEATURE_BOUNDARY, ...CORE_OWNERSHIP, NODE_FILE_SINK] }
      ]
    }
  },
  {
    // Main owns the log file: it opens the sink it shares with the renderer receiver and prunes
    // expired days at startup. It runs in full Node, so the descriptor is safe to hold here.
    files: ['src/main/logging/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [NODE_PTY], patterns: [FEATURE_BOUNDARY, ...CORE_OWNERSHIP] }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [NODE_PTY, ...ZUSTAND_CREATE],
          patterns: [FEATURE_BOUNDARY, ...CORE_OWNERSHIP, NODE_FILE_SINK]
        }
      ]
    }
  },
  {
    // The single sanctioned zustand caller keeps the other rules but not the ban.
    files: ['src/renderer/src/shared/store/createStore.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [NODE_PTY], patterns: [FEATURE_BOUNDARY, ...CORE_OWNERSHIP, NODE_FILE_SINK] }
      ]
    }
  },
  {
    // The single sanctioned node-pty importer keeps the other rules but not the ban.
    files: ['src/core/pty/nodePtySpawn.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [NO_ELECTRON_IN_CORE], patterns: [FEATURE_BOUNDARY] }
      ]
    }
  },
  {
    files: ['e2e/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [PLAYWRIGHT_ELECTRON] }]
    }
  },
  {
    // The harness is the sanctioned launcher, and now the only one.
    files: ['e2e/harness.ts'],
    rules: {
      'no-restricted-imports': 'off'
    }
  }
)
