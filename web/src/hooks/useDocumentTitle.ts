import { useEffect } from "react"

const BASE_TITLE = "Classroom 50"

/**
 * Sets `document.title` for the current page and restores the base title on
 * unmount. Client-only SPA, so the title is managed imperatively. Pass the
 * page-specific part; the app name is appended (e.g. "Assignments · Classroom
 * 50").
 */
export function useDocumentTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} · ${BASE_TITLE}` : BASE_TITLE
    return () => {
      document.title = BASE_TITLE
    }
  }, [title])
}

export default useDocumentTitle
