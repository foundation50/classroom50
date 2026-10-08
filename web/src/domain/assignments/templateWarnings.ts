import type { GitHubRepo } from "@/github-core/types"
import type { Assignment } from "@/types/classroom"
import type { LocalizedMessage } from "@/types/localizedMessage"

// GitHub copies a team's permission on a private repo onto every private fork,
// so each time the classroom team is added to a private in-org template the
// template's forks inherit the read (commonly GitHub Classroom student repos,
// forks of the starter since 2024). Revoking does not cascade to the forks and
// the next grant re-propagates, which is why the copy says to switch the
// template before cleaning the forks. Never a block: the forks may be
// staff-owned.
//
// Named, not rendered: every re-grant path (unlock, reuse, edit) returns this
// and the view resolves the key, so the message is translated like the create
// form's pre-flight note. `granted` picks the tense: a grant withheld for an
// owner has not reached the forks yet.
export function templateForksNotice(
  template: NonNullable<Assignment["template"]>,
  repo: Pick<GitHubRepo, "private" | "forks_count"> | null,
  granted: boolean,
): LocalizedMessage | undefined {
  const count = repo?.forks_count ?? 0
  if (!repo?.private || count === 0) return undefined
  return {
    key: granted
      ? "assignments.template.forksInherit"
      : "assignments.template.forksWillInherit",
    params: { owner: template.owner, repo: template.repo, count },
  }
}
