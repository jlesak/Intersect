import type {
  AgentCatalogItem,
  AgentToolingScope,
  ClaudeMemoryDetail,
  ClaudeMemoryProject,
  ClaudeMemorySummary,
  ConfigEditRequest,
  ConfigPreview,
  ConfigSaveRequest,
  ConfigSaveResult,
  ConfigSource,
  ConfigUndoResult,
  EffectiveConfig,
  RawTargetView,
  SkillCatalogItem
} from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the Agent Tooling store and the preload bridge.
export const getEffectiveConfig = (scope: AgentToolingScope): Promise<EffectiveConfig> =>
  ipc().agentTooling.getEffectiveConfig(scope)
export const listSkills = (scope: AgentToolingScope): Promise<SkillCatalogItem[]> =>
  ipc().agentTooling.listSkills(scope)
export const listAgents = (scope: AgentToolingScope): Promise<AgentCatalogItem[]> =>
  ipc().agentTooling.listAgents(scope)
export const listMemoryProjects = (): Promise<ClaudeMemoryProject[]> =>
  ipc().agentTooling.listMemoryProjects()
export const listMemories = (slug: string | null, query: string): Promise<ClaudeMemorySummary[]> =>
  ipc().agentTooling.listMemories(slug, query)
export const readMemory = (slug: string, filename: string): Promise<ClaudeMemoryDetail | null> =>
  ipc().agentTooling.readMemory(slug, filename)
export const openMemoryExternal = (url: string): Promise<void> => ipc().system.openExternal(url)
/** Reveal a discovered source file in the OS file manager (guarded, Electron-only). */
export const revealPath = (path: string): Promise<void> => ipc().system.revealPath(path)

/** The current text + revision of one writable target file, for the raw JSON editor. */
export const readRaw = (scope: AgentToolingScope, source: ConfigSource): Promise<RawTargetView> =>
  ipc().agentTooling.readRaw(scope, source)
/** Preview a mutation of one config file (current + proposed bytes, revision, validation). */
export const previewSave = (req: ConfigEditRequest): Promise<ConfigPreview> =>
  ipc().agentTooling.previewSave(req)
/** Commit a previewed mutation under its revision guard, backing up and writing atomically. */
export const commitSave = (req: ConfigSaveRequest): Promise<ConfigSaveResult> =>
  ipc().agentTooling.commitSave(req)
/** Undo the last committed save of a target file, restoring the exact prior bytes. */
export const undoSave = (targetPath: string): Promise<ConfigUndoResult> =>
  ipc().agentTooling.undoSave(targetPath)
