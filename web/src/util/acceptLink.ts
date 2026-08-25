// The student-facing accept link for one assignment, and its CLI equivalent.
// Two teacher surfaces hand the URL to students — the submissions page's share
// modal and the assignments list's per-row copy action — so it is built here: a
// protected classroom's capability secret has to ride along as `?k=` on every
// copy, else the student hits "not found". The CLI form has one caller today,
// but lives beside the URL because drift between the two is the real hazard.

export function acceptLinkUrl(
  org: string,
  classroom: string,
  assignment: string,
  secret?: string,
): string {
  const path = `${window.location.origin}/${org}/${classroom}/assignments/${assignment}/accept`
  // Encoded defensively, like classroomPagesSegment: a secret is already
  // `[a-z0-9]`-constrained at every trust boundary, but encoding stops a future
  // looser source from breaking out of the query value.
  return secret ? `${path}?k=${encodeURIComponent(secret)}` : path
}

export function acceptLinkCli(
  org: string,
  classroom: string,
  assignment: string,
  secret?: string,
): string {
  return (
    `gh student accept ${org} ${classroom} ${assignment}` +
    (secret ? ` --key ${secret}` : "")
  )
}
