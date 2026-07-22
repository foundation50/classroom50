import { ExternalLink } from "lucide-react"
import { useId } from "react"
import { useTranslation } from "react-i18next"

import { Button, Modal } from "@/components/ui"

// Explains why a Free-plan org can't be set up and points the teacher at the
// GitHub Education benefit that upgrades an org to Team for free. Opened from a
// Free-plan row in NewOrgModal. Facts per GitHub Education docs: verified
// teachers can upgrade any org they own to GitHub Team at no cost.
function FreePlanInfoModal({
  open,
  orgLogin,
  onClose,
}: {
  open: boolean
  orgLogin: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const titleId = useId()

  return (
    <Modal open={open} onClose={onClose} size="md" aria-labelledby={titleId}>
      <h3 id={titleId} className="text-lg font-bold">
        {t("orgs.newOrg.freePlanInfo.title")}
      </h3>
      {orgLogin && (
        <p className="mt-1 font-mono text-sm text-base-content/60">
          {orgLogin}
        </p>
      )}

      <p className="mt-4 text-sm leading-6 text-base-content/80">
        {t("orgs.newOrg.freePlanInfo.body")}
      </p>

      <div className="mt-4 rounded-box border border-info/20 bg-info/5 p-4">
        <p className="text-sm font-semibold">
          {t("orgs.newOrg.freePlanInfo.educationTitle")}
        </p>
        <p className="mt-1 text-sm leading-6 text-base-content/70">
          {t("orgs.newOrg.freePlanInfo.educationBody")}
        </p>
        <Button
          as="a"
          href="https://github.com/education"
          target="_blank"
          rel="noreferrer"
          variant="info"
          size="sm"
          className="mt-3"
        >
          {t("orgs.newOrg.freePlanInfo.educationCta")}
          <ExternalLink aria-hidden="true" className="size-4" />
        </Button>
      </div>

      <div className="modal-action">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("orgs.newOrg.freePlanInfo.dismiss")}
        </Button>
      </div>
    </Modal>
  )
}

export default FreePlanInfoModal
