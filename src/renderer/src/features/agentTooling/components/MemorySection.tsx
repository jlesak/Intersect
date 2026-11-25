import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Root, RootContent, PhrasingContent } from 'mdast'
import type { ClaudeMemoryDetail, ClaudeMemoryProject, ClaudeMemorySummary } from '@common/domain'
import * as api from '../ipc'

/** Remark visits text only, so fenced and inline code are left intact. */
export function memoryWikilinks() {
  function visit(node: Root | RootContent): void {
    if (node.type === 'link' || node.type === 'linkReference') return
    if (!('children' in node)) return
    const children = node.children as PhrasingContent[]
    const next: PhrasingContent[] = []
    for (const child of children) {
      if (child.type !== 'text') {
        visit(child as RootContent)
        next.push(child)
        continue
      }
      const pattern = /\[\[([^\]\n]+)\]\]/g
      let start = 0
      for (const match of child.value.matchAll(pattern)) {
        const index = match.index ?? 0
        if (index > start) next.push({ type: 'text', value: child.value.slice(start, index) })
        next.push({ type: 'link', url: `memory:${encodeURIComponent(match[1])}`, children: [
          { type: 'text', value: match[1] }
        ] })
        start = index + match[0].length
      }
      if (start < child.value.length) next.push({ type: 'text', value: child.value.slice(start) })
    }
    ;(node as { children: PhrasingContent[] }).children = next
  }
  return (tree: Root): void => visit(tree)
}

function relativeTime(ms: number | null): string {
  if (ms === null) return 'unknown time'
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const keyOf = (item: ClaudeMemorySummary): string => `${item.slug}/${item.filename}`

export function MemorySection() {
  const [projects, setProjects] = useState<ClaudeMemoryProject[]>([])
  const [project, setProject] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<ClaudeMemorySummary[]>([])
  const [resultKey, setResultKey] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ClaudeMemoryDetail | null>(null)
  const [links, setLinks] = useState<ClaudeMemorySummary[]>([])
  const [linksSlug, setLinksSlug] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const queryKey = JSON.stringify([project, query, refresh])
  const visibleItems = resultKey === queryKey ? items : []

  useEffect(() => {
    let live = true
    api.listMemoryProjects().then((result) => { if (live) setProjects(result) })
      .catch((e) => { if (live) setError(String(e)) })
    return () => { live = false }
  }, [refresh])

  useEffect(() => {
    let live = true
    setResultKey('')
    setDetail(null)
    api.listMemories(project, query).then((result) => {
      if (!live) return
      setItems(result)
      setResultKey(queryKey)
      setSelected((old) => old && result.some((item) => keyOf(item) === old)
        ? old : result[0] ? keyOf(result[0]) : null)
      setError(null)
    }).catch((e) => { if (live) setError(String(e)) })
    return () => { live = false }
  }, [project, query, refresh, queryKey])

  const current = useMemo(() => visibleItems.find((item) => keyOf(item) === selected) ?? null,
    [visibleItems, selected])
  const currentSlug = current?.slug ?? null
  useEffect(() => {
    let live = true
    setLinksSlug(null)
    if (currentSlug) api.listMemories(currentSlug, '').then((result) => {
      if (live) { setLinks(result); setLinksSlug(currentSlug) }
    }).catch((e) => { if (live) setError(String(e)) })
    return () => { live = false }
  }, [currentSlug, refresh])
  const linkTargets = linksSlug === detail?.slug ? links : []
  useEffect(() => {
    let live = true
    setDetail(null)
    if (current) api.readMemory(current.slug, current.filename).then((result) => {
      if (live) setDetail(result)
    }).catch((e) => { if (live) setError(String(e)) })
    return () => { live = false }
  }, [current])

  const followWiki = (name: string): void => {
    if (!detail) return
    const target = linkTargets.find((item) => item.slug === detail.slug &&
      (item.name === name || item.filename === `${name}.md`))
    if (target) { setQuery(''); setSelected(keyOf(target)) }
  }

  return (
    <div className="ix-memory">
      <aside className="ix-memory__projects" aria-label="Memory projects">
        <button type="button" className={project === null ? 'ix-memory__active' : ''}
          onClick={() => setProject(null)}>All projects <span>{projects.reduce((n, p) => n + p.count, 0)}</span></button>
        {projects.map((p) => <button type="button" key={p.slug} title={p.slug}
          className={project === p.slug ? 'ix-memory__active' : ''}
          onClick={() => setProject(p.slug)}>{p.name} <span>{p.count}</span></button>)}
      </aside>
      <section className="ix-memory__list" aria-label="Memories">
        <div className="ix-memory__toolbar">
          <input className="ix-input" aria-label="Search memories" placeholder="Search memories…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="button" className="ix-btn ix-btn--ghost" onClick={() => setRefresh((n) => n + 1)}>Refresh</button>
        </div>
        {error && <div role="alert" className="ix-at-error">{error}</div>}
        {visibleItems.length === 0 && !error && <div className="ix-at-catalog__empty">No memories found</div>}
        {visibleItems.map((item) => <button type="button" key={keyOf(item)}
          className={`ix-memory__row${keyOf(item) === selected ? ' ix-memory__active' : ''}`}
          onClick={() => setSelected(keyOf(item))}>
          <span className="ix-memory__row-title">{item.name}</span>
          <span className="ix-chip">{item.type}</span>
          <span className="ix-memory__row-desc">{item.description || item.error || item.filename}</span>
          <span className="ix-memory__row-time">{relativeTime(item.mtime)}</span>
        </button>)}
      </section>
      <section className="ix-memory__preview" aria-label="Memory preview">
        {detail && <>
          <h3>{detail.name}</h3>
          <div className="ix-memory__chips">
            <span className="ix-chip">name: {detail.name}</span>
            <span className="ix-chip">type: {detail.type}</span>
            {detail.description && <span className="ix-chip">description: {detail.description}</span>}
          </div>
          {detail.error ? <div role="alert">{detail.error}</div> : <div className="ix-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm, memoryWikilinks]} skipHtml
              urlTransform={(url) => url.startsWith('memory:') || /^https:\/\//i.test(url) ? url : ''}
              components={{
                img: () => null,
                a: ({ href, children }) => {
                  if (href?.startsWith('memory:')) {
                    let name = ''
                    try { name = decodeURIComponent(href.slice('memory:'.length)) } catch { /* malformed link */ }
                    const target = linkTargets.find((item) => item.slug === detail.slug &&
                      (item.name === name || item.filename === `${name}.md`))
                    return target ? <button type="button" className="ix-memory__link"
                      onClick={() => followWiki(name)}>{children}</button>
                      : <span className="ix-memory__unresolved">{children}</span>
                  }
                  if (!href || !/^https:\/\//i.test(href)) return <span>{children}</span>
                  return <button type="button" className="ix-memory__link" onClick={() => {
                    void api.openMemoryExternal(href).catch((reason) => setError(String(reason)))
                  }}>{children}</button>
                }
              }}>{detail.body}</ReactMarkdown>
          </div>}
        </>}
      </section>
    </div>
  )
}
