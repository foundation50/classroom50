import { Trans, useTranslation } from "react-i18next"
import { Alert, Button, Modal } from "@/components/ui"
import { LinkExternalIcon } from "@/components/ui/icons"
import { WIKI_URL } from "@/version"

// Walks a teacher through keeping test scripts out of the template: write a
// script, drop it on GitHub's upload page for the assignment's bundle folder,
// call it from a run test via $CLASSROOM50_BUNDLE_DIR. Both props are null
// until the assignment exists (create mode), since the folder is keyed by the
// saved slug; the modal then only says to create the assignment first, since
// none of the steps are actionable yet.
export function TeacherFilesModal({
  open,
  onClose,
  bundlePath,
  uploadUrl,
}: {
  open: boolean
  onClose: () => void
  bundlePath: string | null
  uploadUrl: string | null
}) {
  const { t } = useTranslation()
  const markup = { code: <code dir="ltr" />, strong: <strong /> }

  if (!bundlePath || !uploadUrl) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        size="md"
        title={t("assignments.autograder.teacherFiles.title")}
        footer={
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        }
      >
        <p className="mt-6 text-sm text-base-content/70">
          <Trans
            i18nKey="assignments.autograder.teacherFiles.unsaved"
            components={markup}
          />
        </p>
      </Modal>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="2xl"
      title={t("assignments.autograder.teacherFiles.title")}
      subtitle={t("assignments.autograder.teacherFiles.subtitle")}
      footer={
        <>
          <a
            className="link me-auto inline-flex items-center gap-1 text-sm text-base-content/60 hover:text-base-content"
            href={`${WIKI_URL}/Autograding-Basics#teacher-only-test-files`}
            target="_blank"
            rel="noreferrer"
          >
            {t("assignments.autograder.teacherFiles.learnMore")}
            <LinkExternalIcon aria-hidden="true" className="size-4" />
          </a>
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button
            as="a"
            variant="primary"
            href={uploadUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t("assignments.autograder.teacherFiles.openUpload")}
            <LinkExternalIcon aria-hidden="true" className="size-4" />
          </Button>
        </>
      }
    >
      <ol className="mt-6 list-decimal space-y-4 ps-5 text-sm">
        <li>
          <p className="font-bold">
            {t("assignments.autograder.teacherFiles.step1Title")}
          </p>
          <p className="text-base-content/70">
            <Trans
              i18nKey="assignments.autograder.teacherFiles.step1Body"
              components={markup}
            />
          </p>
          <pre
            dir="ltr"
            className="mt-2 overflow-x-auto rounded bg-base-200 p-3 text-xs"
          >
            {[
              "# check.sh",
              "set -euo pipefail",
              'test "$(python3 add.py 2 3)" = "5"',
              'test "$(python3 add.py -1 1)" = "0"',
            ].join("\n")}
          </pre>
        </li>
        <li>
          <p className="font-bold">
            {t("assignments.autograder.teacherFiles.step2Title")}
          </p>
          <p className="text-base-content/70">
            <Trans
              i18nKey="assignments.autograder.teacherFiles.step2Body"
              values={{ path: bundlePath }}
              components={markup}
            />
          </p>
          <p className="mt-1 text-base-content/70">
            <Trans
              i18nKey="assignments.autograder.teacherFiles.step2Note"
              components={markup}
            />
          </p>
        </li>
        <li>
          <p className="font-bold">
            {t("assignments.autograder.teacherFiles.step3Title")}
          </p>
          <p className="text-base-content/70">
            <Trans
              i18nKey="assignments.autograder.teacherFiles.step3Body"
              components={markup}
            />
          </p>
          <pre
            dir="ltr"
            className="mt-2 overflow-x-auto rounded bg-base-200 p-3 text-xs"
          >
            {'bash "$CLASSROOM50_BUNDLE_DIR/check.sh"'}
          </pre>
        </li>
        <li>
          <p className="font-bold">
            {t("assignments.autograder.teacherFiles.step4Title")}
          </p>
          <p className="text-base-content/70">
            <Trans
              i18nKey="assignments.autograder.teacherFiles.step4Body"
              components={markup}
            />
          </p>
        </li>
      </ol>
      <Alert
        tone="warning"
        className="mt-6 text-sm"
        title={t("assignments.autograder.teacherFiles.readableTitle")}
      >
        <p>
          <Trans
            i18nKey="assignments.autograder.teacherFiles.readableBody"
            components={markup}
          />
        </p>
      </Alert>
    </Modal>
  )
}
