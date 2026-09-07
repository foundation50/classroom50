import { Trans, useTranslation } from "react-i18next"
import {
  Alert,
  Button,
  CopyableCode,
  ExternalLink,
  Modal,
} from "@/components/ui"
import { LinkExternalIcon } from "@/components/ui/icons"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { WIKI_URL } from "@/version"

const WIKI_HREF = `${WIKI_URL}/Autograding-Basics#teacher-only-test-files`
// The Run command a teacher pastes into a declarative test to reach a script in
// the bundle; shown so it can be copied rather than retyped.
const EXAMPLE_RUN_COMMAND = 'bash "$CLASSROOM50_BUNDLE_DIR/check.sh"'

// Tells a teacher how to get test scripts into the assignment's bundle folder
// without cloning the classroom50 repository: GitHub's upload page, plus the
// two facts that change what they should upload (autograder.py overrides the
// tests; the bundle is publicly readable). The worked example lives in the
// wiki. Both props are null until the assignment exists (create mode), since
// the folder is keyed by the saved slug; the modal then only says to create
// the assignment first.
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
  const { copied: copiedCommand, copy: copyCommand } = useCopyToClipboard(
    EXAMPLE_RUN_COMMAND,
    1500,
  )

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
      size="lg"
      title={t("assignments.autograder.teacherFiles.title")}
      subtitle={t("assignments.autograder.teacherFiles.subtitle")}
      footer={
        <>
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
      <div className="mt-6 space-y-3 text-sm text-base-content/70">
        <p>
          <Trans
            i18nKey="assignments.autograder.teacherFiles.howTo"
            values={{ path: bundlePath }}
            components={markup}
          />
        </p>
        <p>
          <Trans
            i18nKey="assignments.autograder.teacherFiles.usage"
            components={markup}
          />
        </p>
        <CopyableCode
          value={EXAMPLE_RUN_COMMAND}
          copied={copiedCommand}
          onCopy={copyCommand}
          label={t("assignments.autograder.teacherFiles.copyCommand")}
        />
        <p>
          <ExternalLink href={WIKI_HREF}>
            {t("assignments.autograder.teacherFiles.example")}
          </ExternalLink>
        </p>
        <p>
          <Trans
            i18nKey="assignments.autograder.teacherFiles.note"
            components={markup}
          />
        </p>
      </div>
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
