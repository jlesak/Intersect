/// <reference types="vite/client" />
import type * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

/**
 * Wires Monaco's language/diff web workers to Vite-emitted, same-origin ES-module chunks. Monaco
 * spins up a worker per language service; `getWorker` maps the worker `label` to the matching
 * constructor and falls back to the plain editor worker. Importing this module for its side effect
 * (before anything touches Monaco) is what makes the diff editor work under the renderer CSP, which
 * allows `worker-src 'self' blob:` but not a CDN loader.
 */
;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  }
}
