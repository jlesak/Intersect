export {}

declare global {
  interface Window {
    // Replaced with the typed IpcApi surface when the IPC layer lands.
    jarvis: unknown
  }
}
