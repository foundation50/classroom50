import type { TFunction } from "i18next"

import type { BulkAddToClassroomResult } from "@/domain/orgMembers/bulkAddToClassroom"
import type { BulkRemoveFromClassroomResult } from "@/domain/orgMembers/bulkRemoveFromClassroom"
import type { BulkRemoveFromOrgResult } from "@/domain/orgMembers/bulkRemoveFromOrg"
import type { BulkResultView } from "@/components/bulk/resultView"

// Pure builders turning each bulk orchestrator's result into the shared
// result-modal view (headline + sectioned rows). Split out of BulkActionsBar
// so the component carries only state and wiring.

export const buildAddResult = (
  res: BulkAddToClassroomResult,
  classroom: string,
  t: TFunction,
): BulkResultView => {
  const added = res.enroll?.addedStudents ?? []
  const csvSkipped = res.enroll?.skippedStudents ?? []
  const teamFailed = (res.enroll?.teamResults ?? []).filter(
    (r) => r.status === "failed",
  )
  const sections: BulkResultView["sections"] = []
  if (added.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultAdded"),
      rows: added.map((s) => ({
        key: s.username,
        label: s.username,
        detail: [s.first_name, s.last_name].filter(Boolean).join(" "),
      })),
    })
  }
  const skipped = [
    ...res.preSkipped.map((s) => ({
      key: s.key,
      label: s.label,
      detail: t(`orgMembers.bulk.skipReason.${s.reason}`),
    })),
    ...csvSkipped.map((s) => ({
      key: s.username,
      label: s.username,
      detail: s.message ?? s.reason,
    })),
  ]
  if (skipped.length > 0) {
    sections.push({ title: t("orgMembers.bulk.resultSkipped"), rows: skipped })
  }
  if (teamFailed.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultTeamFailures"),
      rows: teamFailed.map((r) => ({
        key: r.username,
        label: r.username,
        detail: r.message ?? t("orgMembers.bulk.couldNotAddToTeam"),
      })),
    })
  }
  return {
    headline: t("orgMembers.bulk.addedHeadline", {
      count: added.length,
      classroom,
    }),
    sections,
  }
}

export const buildRemoveResult = (
  res: BulkRemoveFromClassroomResult,
  classroom: string,
  t: TFunction,
): BulkResultView => {
  const removed = res.outcomes.filter((o) => o.status === "removed")
  const skipped = res.outcomes.filter((o) => o.status === "skipped")
  const failed = res.outcomes.filter((o) => o.status === "failed")
  const sections: BulkResultView["sections"] = []
  if (skipped.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultSkipped"),
      rows: skipped.map((o) => ({
        key: o.key,
        label: o.label,
        detail: o.detail
          ? t(`orgMembers.bulk.skipReason.${o.detail}`, {
              defaultValue: o.detail,
            })
          : undefined,
      })),
    })
  }
  if (failed.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultFailed"),
      rows: failed.map((o) => ({
        key: o.key,
        label: o.label,
        detail: o.detail,
      })),
    })
  }
  // Non-fatal side-effect warnings (team drop / invite cancel) — roster removal
  // itself succeeded, so these are informational.
  if (res.warnings.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultWarnings"),
      rows: res.warnings.map((message, i) => ({
        key: `warning-${i}`,
        label: message,
      })),
    })
  }
  return {
    headline: t("orgMembers.bulk.removedHeadline", {
      count: removed.length,
      classroom,
    }),
    sections,
  }
}

export const buildOrgRemoveResult = (
  res: BulkRemoveFromOrgResult,
  org: string,
  t: TFunction,
): BulkResultView => {
  const removed = res.outcomes.filter((o) => o.status === "removed")
  const skipped = res.outcomes.filter((o) => o.status === "skipped")
  const failed = res.outcomes.filter((o) => o.status === "failed")
  const sections: BulkResultView["sections"] = []
  // Removed rows are listed (unlike the classroom-scoped remove) because each
  // carries its own blast radius: how many classrooms the removal unenrolled.
  if (removed.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultRemoved"),
      rows: removed.map((o) => ({
        key: o.key,
        label: o.label,
        detail:
          o.unenrolledClassrooms.length > 0
            ? t("orgMembers.bulk.unenrolledDetail", {
                count: o.unenrolledClassrooms.length,
                classrooms: o.unenrolledClassrooms.join(", "),
              })
            : undefined,
      })),
    })
  }
  if (skipped.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultSkipped"),
      rows: skipped.map((o) => ({
        key: o.key,
        label: o.label,
        detail: o.detail
          ? t(`orgMembers.bulk.skipReason.${o.detail}`, {
              defaultValue: o.detail,
            })
          : undefined,
      })),
    })
  }
  if (failed.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultFailed"),
      rows: failed.map((o) => ({
        key: o.key,
        label: o.label,
        detail: o.detail,
      })),
    })
  }
  if (res.warnings.length > 0) {
    sections.push({
      title: t("orgMembers.bulk.resultWarnings"),
      rows: res.warnings.map((message, i) => ({
        key: `warning-${i}`,
        label: message,
      })),
    })
  }
  return {
    headline: t("orgMembers.bulk.removedFromOrgHeadline", {
      count: removed.length,
      org,
    }),
    sections,
  }
}
