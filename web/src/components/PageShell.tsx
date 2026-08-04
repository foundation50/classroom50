import type { ReactNode } from "react"

const DEFAULT_CONTENT_CLASS = "p-6 bg-base-200 2xl:px-8"

// Per-page content frame. The drawer + sidebar now live once in the persistent
// AppShell (rendered by the `_authed` layout route), so a page only supplies its
// own content and padding here — it no longer wraps the drawer or declares its
// sidebar active state (that's route-derived in useSidebarNav).
//
// contentClassName overrides the default tight p-6 frame. The one vertical
// rhythm (sections as direct children spaced by gap-6) is kept so pages don't
// hand-roll per-block margins.
export default function PageShell({
  children,
  contentClassName = DEFAULT_CONTENT_CLASS,
}: {
  children: ReactNode
  contentClassName?: string
}) {
  return (
    <div className={contentClassName}>
      <div className="flex flex-col gap-6">{children}</div>
    </div>
  )
}
