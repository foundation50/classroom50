import type { TFunction } from "i18next"

import {
  assignmentSlugBudget,
  composedRepoNameFits,
  CLASSROOM_SHORT_NAME_MAX_LEN,
  GITHUB_REPO_NAME_MAX_LEN,
} from "@/util/repoNameBudget"

// The composed repo-name budget error for `slug` in `classroom`, or undefined
// when it fits (#691). The single recipe shared by the submit validator, the
// live as-you-type checks (DetailsSection, RenameAssignmentModal), and the
// migration confirm step. A classroom leaving no room for any slug (a legacy
// over-long short-name) points at a new classroom instead of an impossible
// shorter slug, mirroring the CLI's ComposedRepoNameBudget. Lives in
// components/ (not pages/) so modals can import it without crossing the layer
// boundary.
export function slugBudgetError(
  t: TFunction,
  classroom: string,
  slug: string,
): string | undefined {
  if (composedRepoNameFits(classroom, slug).fits) return undefined
  const budget = assignmentSlugBudget(classroom)
  if (budget < 2) {
    return t("assignments.form.validation.slugNoRoom", {
      classroom,
      max: CLASSROOM_SHORT_NAME_MAX_LEN,
      limit: GITHUB_REPO_NAME_MAX_LEN,
    })
  }
  return t("assignments.form.validation.slugOverBudget", {
    classroom,
    budget,
    length: slug.length,
    limit: GITHUB_REPO_NAME_MAX_LEN,
  })
}
