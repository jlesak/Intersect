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
    // The single sanctioned node-pty importer keeps the other rules but not the ban.
    files: ['src/core/pty/nodePtySpawn.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [NO_ELECTRON_IN_CORE], patterns: [FEATURE_BOUNDARY] }
      ]
    }
  }
)
