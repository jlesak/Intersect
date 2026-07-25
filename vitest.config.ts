import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// node:sqlite repositories and pure logic run under the host Node (no native rebuild).
// node-pty is never imported by any unit test, so its Electron-ABI binary is irrelevant here.
export default defineConfig({
  // Compile TSX with the automatic JSX runtime, exactly as the renderer build does. Without it
  // esbuild honours the web tsconfig's "jsx": "preserve" and emits classic React.createElement.
  plugins: [react()],
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
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: [resolve(__dirname, 'vitest.setup.dom.ts')]
        }
      }
    ]
  }
})
