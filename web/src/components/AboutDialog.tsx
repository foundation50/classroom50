import { forwardRef } from "react"
import { useTranslation } from "react-i18next"
import { ExternalLink } from "lucide-react"

import { CopyableDetails, Modal } from "@/components/ui"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { buildDiagnostics } from "@/lib/diagnostics/snapshot"
import {
  appVersion,
  commitUrl,
  releaseUrl,
  shortCommit,
  ISSUES_URL,
  DISCUSSIONS_URL,
} from "@/version"

// A single feedback/support link card. The two support links differ only in
// href + labels, so they share one definition.
function SupportLink({
  href,
  title,
  hint,
}: {
  href: string
  title: string
  hint: string
}) {
  return (
    <a
      className="flex items-center gap-3 rounded-lg border border-base-300 px-3 py-2 transition-colors hover:border-primary/40 hover:bg-base-200"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-base-content/60">{hint}</span>
      </span>
      <ExternalLink
        aria-hidden="true"
        className="size-3.5 shrink-0 text-base-content/40"
      />
    </a>
  )
}

// Collapsible "Copy diagnostics" block: an allow-listed snapshot the user can
// paste into a bug report. Nothing is sent anywhere — copy-to-clipboard only.
function CopyableDiagnostics({
  org,
  planName,
}: {
  org?: string | null
  planName?: string
}) {
  const { t } = useTranslation()
  const text = buildDiagnostics({ org, planName })
  const { copied, copy } = useCopyToClipboard(text)

  return (
    <CopyableDetails
      text={text}
      copied={copied}
      onCopy={() => void copy()}
      summaryLabel={t("nav.aboutDiagnosticsShow")}
      copyLabel={t("nav.aboutDiagnosticsCopy")}
      copiedLabel={t("nav.aboutDiagnosticsCopied")}
      className="mt-2"
      preClassName="max-h-48"
    />
  )
}

// About modal from the profile menu — always-accessible build/version info.
// Version links to the GitHub Release for this build's `web-v<version>` tag
// (when it exists); the commit links to the exact source commit, so a bug report
// can point at precisely what shipped.
export const AboutDialog = forwardRef<
  HTMLDialogElement,
  { titleId: string; org?: string | null; planName?: string }
>(function AboutDialog({ titleId, org, planName }, ref) {
  const { t } = useTranslation()
  const release = releaseUrl()

  return (
    <Modal
      ref={ref}
      size="2xl"
      boxClassName="flex max-h-[85vh] flex-col overflow-y-auto text-base-content"
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="text-lg font-bold">
        {t("nav.aboutDialogTitle")}
      </h3>
      <p className="mt-1 mb-4 text-sm text-base-content/70">
        {t("nav.aboutDialogDescription")}
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-base-content/60">{t("nav.aboutVersion")}</dt>
        <dd className="font-mono tabular-nums">
          {release ? (
            <a
              className="link link-info link-hover inline-flex items-center gap-1"
              href={release}
              target="_blank"
              rel="noreferrer"
            >
              v{appVersion.version}
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          ) : (
            <>v{appVersion.version}</>
          )}
        </dd>

        <dt className="text-base-content/60">{t("nav.aboutCommit")}</dt>
        <dd className="font-mono">
          <a
            className="link link-info link-hover inline-flex items-center gap-1"
            href={commitUrl()}
            target="_blank"
            rel="noreferrer"
          >
            {shortCommit()}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        </dd>

        <dt className="text-base-content/60">{t("nav.aboutBuilt")}</dt>
        <dd className="font-mono tabular-nums">{appVersion.buildDate}</dd>
      </dl>

      <div className="divider my-4" />

      <h4 className="mb-3 text-sm font-semibold">
        {t("nav.aboutSupportTitle")}
      </h4>
      <div className="flex flex-col gap-2">
        <SupportLink
          href={DISCUSSIONS_URL}
          title={t("nav.aboutAskQuestion")}
          hint={t("nav.aboutAskQuestionHint")}
        />
        <SupportLink
          href={ISSUES_URL}
          title={t("nav.aboutReportIssue")}
          hint={t("nav.aboutReportIssueHint")}
        />
      </div>

      <div className="divider my-4" />

      <h4 className="mb-1 text-sm font-semibold">
        {t("nav.aboutDiagnosticsTitle")}
      </h4>
      <p className="mb-2 text-xs text-base-content/60">
        {t("nav.aboutDiagnosticsHint")}
      </p>
      <CopyableDiagnostics org={org} planName={planName} />
    </Modal>
  )
})
