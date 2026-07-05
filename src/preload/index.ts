import { contextBridge } from 'electron'

// The full typed bridge (window.jarvis) is wired up alongside the IPC layer.
// Stage-1 placeholder so the renderer has a stable global to feature-detect against.
contextBridge.exposeInMainWorld('jarvis', {})
