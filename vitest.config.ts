import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// node:sqlite repositories and pure logic run under the host Node (no native rebuild).
// node-pty is never imported by any unit test, so its Electron-ABI binary is irrelevant here.
export default defineConfig({
  resolve: {
    alias: {
      '@common': resolve(__dirname, 'src/common'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/common/**/*.{test,spec}.ts',
            'src/core/**/*.{test,spec}.ts',
            'src/main/**/*.{test,spec}.ts',
            'src/shared/**/*.{test,spec}.ts'
          ]
        }
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}']
        }
      }
    ]
  }
})
