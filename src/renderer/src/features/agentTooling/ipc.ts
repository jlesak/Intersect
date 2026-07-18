import type {
  AgentCatalogItem,
  AgentToolingScope,
  EffectiveConfig,
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
/** Reveal a discovered source file in the OS file manager (guarded, Electron-only). */
export const revealPath = (path: string): Promise<void> => ipc().system.revealPath(path)
