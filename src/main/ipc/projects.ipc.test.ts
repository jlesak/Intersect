import type { IpcMain } from 'electron'
import { beforeEach, describe, expect, test } from 'vitest'
import { Channel, type IpcApi } from '@common/ipc'
import { createProjectRepo, type ProjectRepo } from '../db/projectRepo'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import { createProjectHandlers, registerProjectHandlers } from './projects.ipc'

function makeHandlers(): { projects: ProjectRepo; h: IpcApi['projects'] } {
  const db = makeTestDb()
  const projects = createProjectRepo(db, { ...makeTestDeps(), canonicalize: (p) => p })
  const h = createProjectHandlers({
    projects,
    pathDeps: {
      canonicalize: (p) => p,
      worktreeParentRoot: (p) => (p.startsWith('/wt/') ? '/repos/' + p.split('/')[2] : null)
    }
  })
  return { projects, h }
}

describe('project handlers', () => {
  let h: IpcApi['projects']

  beforeEach(() => {
    h = makeHandlers().h
  })

  test('full CRUD and binding management round-trips through the handlers', async () => {
    const created = await h.create('SPOT', '/repos/spot')
    expect(created.repoPaths).toEqual(['/repos/spot'])

    const updated = await h.update(created.id, {
      jiraJql: 'project = FID2507',
      adoRepositories: ['spot-backend']
    })
    expect(updated.jiraJql).toBe('project = FID2507')
    expect(updated.adoRepositories).toEqual(['spot-backend'])

    const withPath = await h.addRepoPath(created.id, '/repos/spot-backend')
    expect(withPath.repoPaths).toEqual(['/repos/spot', '/repos/spot-backend'])
    const withoutPath = await h.removeRepoPath(created.id, '/repos/spot-backend')
    expect(withoutPath.repoPaths).toEqual(['/repos/spot'])

    const archived = await h.setArchived(created.id, true)
    expect(archived.archived).toBe(true)

    const second = await h.create('Two', '/repos/two')
    const reordered = await h.reorder([second.id, created.id])
    expect(reordered.map((p) => p.id)).toEqual([second.id, created.id])

    await h.remove(second.id)
    expect((await h.list()).map((p) => p.id)).toEqual([created.id])
  })

  test('resolvePath answers with the owning project or null for Other', async () => {
    const p = await h.create('SPOT', '/repos/spot')
    expect(await h.resolvePath('/repos/spot/src')).toBe(p.id)
    expect(await h.resolvePath('/wt/spot/deep')).toBe(p.id)
    expect(await h.resolvePath('/elsewhere')).toBeNull()
  })

  test('repo failures surface as message-only Errors', async () => {
    await h.create('SPOT', '/repos/spot')
    await expect(h.create('Dup', '/repos/spot')).rejects.toThrow(
      'already bound to project "SPOT"'
    )
    await expect(h.update('missing', { name: 'X' })).rejects.toThrow('Project not found')
  })
})

describe('registerProjectHandlers', () => {
  type Listener = (event: unknown, ...args: unknown[]) => unknown
  let listeners: Map<string, Listener>
  let h: IpcApi['projects']

  beforeEach(() => {
    listeners = new Map()
    h = makeHandlers().h
    const fakeIpcMain = {
      handle: (channel: string, listener: Listener) => {
        listeners.set(channel, listener)
      }
    } as unknown as IpcMain
    registerProjectHandlers(fakeIpcMain, h)
  })

  test('registers exactly the project channels', () => {
    expect([...listeners.keys()].sort()).toEqual(
      [
        Channel.projectsList,
        Channel.projectsCreate,
        Channel.projectsUpdate,
        Channel.projectsSetArchived,
        Channel.projectsReorder,
        Channel.projectsRemove,
        Channel.projectsAddRepoPath,
        Channel.projectsRemoveRepoPath,
        Channel.projectsResolvePath
      ].sort()
    )
  })

  test('listeners unwrap ipc args and delegate', async () => {
    const created = (await listeners.get(Channel.projectsCreate)!({}, 'SPOT', '/repos/spot')) as {
      id: string
    }
    const list = (await listeners.get(Channel.projectsList)!({})) as unknown[]
    expect(list).toHaveLength(1)
    const updated = (await listeners.get(Channel.projectsUpdate)!({}, created.id, {
      name: 'SPOT 2'
    })) as { name: string }
    expect(updated.name).toBe('SPOT 2')
    expect(await listeners.get(Channel.projectsResolvePath)!({}, '/repos/spot/x')).toBe(created.id)
  })
})
