import tseslint from 'typescript-eslint'

const FEATURE_BOUNDARY = {
  group: ['@renderer/features/*/*'],
  message: 'Import another feature only through its index barrel (@renderer/features/<name>), never its internals.'
}

const NODE_PTY = {
  name: 'node-pty',
  message: 'node-pty may only be imported by src/main/pty/nodePtySpawn.ts - keeps the native binary out of Vitest and the renderer.'
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
    // The single sanctioned node-pty importer keeps the feature-boundary rule but not the ban.
    files: ['src/main/pty/nodePtySpawn.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [FEATURE_BOUNDARY] }]
    }
  }
)
