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

// Every spec used to launch Electron itself, so one navigation change broke fifteen tests across
// separate files. Launching belongs to the harness; the specs listed below still predate it.
const PLAYWRIGHT_ELECTRON = {
  name: '@playwright/test',
  importNames: ['_electron'],
  message: 'Launch the app via e2e/harness.ts so boot and navigation fixes land in one place.'
}

// Shrinking list: specs not yet moved onto the harness. Do not add to it.
const UNMIGRATED_E2E_SPECS = [
  'e2e/mywork.spec.ts',
  'e2e/palette.spec.ts',
  'e2e/prInbox.live.spec.ts',
  'e2e/prInbox.spec.ts',
  'e2e/prvote.spec.ts',
  'e2e/review-pane-shot.spec.ts',
  'e2e/shortcuts.spec.ts',
  'e2e/smoke.spec.ts'
]

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
          patterns: [FEATURE_BOUNDARY, ...CORE_OWNERSHIP]
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
        { paths: [NODE_PTY], patterns: [FEATURE_BOUNDARY, ...CORE_OWNERSHIP] }
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
    // The harness is the sanctioned launcher; the unmigrated specs are tracked debt.
    files: ['e2e/harness.ts', ...UNMIGRATED_E2E_SPECS],
    rules: {
      'no-restricted-imports': 'off'
    }
  }
)
