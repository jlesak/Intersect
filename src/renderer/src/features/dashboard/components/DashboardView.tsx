/**
 * The Dashboard placeholder holding the rail's top position until the digest/dashboard phase
 * lands. It only names what will live here so the empty state reads as intent, not breakage.
 */
export function DashboardView() {
  return (
    <div className="ix-main">
      <div className="ix-empty">
        <span className="ix-eyebrow">Dashboard</span>
        <div className="ix-empty__title">Nothing here yet</div>
        <p className="ix-empty__hint">
          The daily digest and cross-project overview arrive in a later phase. Pick a project from
          the rail to work in its context.
        </p>
      </div>
    </div>
  )
}
