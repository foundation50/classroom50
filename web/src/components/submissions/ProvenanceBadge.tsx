import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui"
import type { SubmissionProvenance } from "@/types/submissionProvenance"

// The release behind a score wasn't the autograde workflow's own. The score is
// collected and counted; this marks it so the teacher weighs it. Renders
// nothing when the workflow published it, and every score cell mounts one, so
// the i18n subscription lives in the inner component the common case skips.
export function ProvenanceBadge({
  provenance,
}: {
  provenance: SubmissionProvenance | undefined
}) {
  if (!provenance) return null
  return <MarkedBadge provenance={provenance} />
}

// The collector's stored reason is shown as data; the live kinds are phrased here.
function MarkedBadge({ provenance }: { provenance: SubmissionProvenance }) {
  const { t } = useTranslation()
  const login = (value: string | null) =>
    value ?? t("submissions.table.unverifiedUnknownAccount")
  const title =
    provenance.kind === "recorded"
      ? t("submissions.table.unverifiedRecordedTitle", {
          reason: provenance.reason,
        })
      : provenance.kind === "author"
        ? t("submissions.table.unverifiedAuthorTitle", {
            login: login(provenance.login),
          })
        : t("submissions.table.unverifiedUploaderTitle", {
            login: login(provenance.login),
          })
  return (
    <Badge tone="warning" size="sm" title={title}>
      {t("submissions.table.unverified")}
    </Badge>
  )
}
