import { useTranslation } from "react-i18next"

export const GITHUB_STATUS_URL = "https://www.githubstatus.com"

// The outage body text (confirmed vs generic) plus the githubstatus.com link —
// the single source of both, so the copy and URL can't drift across the authed
// banner, the unauthed stuck-bootstrap screen, and the inline field/write hints.
// `block` renders the banner's muted-paragraph + own-line link; the default is
// the inline fragment a caller wraps in its own element.
export function GitHubStatusNote({
  statusDescription,
  block = false,
}: {
  statusDescription: string | null
  block?: boolean
}) {
  const { t } = useTranslation()
  const body = statusDescription
    ? t("githubStatus.bodyConfirmed", { status: statusDescription })
    : t("githubStatus.bodyGeneric")
  const link = (
    <a
      href={GITHUB_STATUS_URL}
      target="_blank"
      rel="noreferrer"
      className={`link link-hover font-semibold text-base-content${
        block ? " self-start" : ""
      }`}
    >
      {t("githubStatus.checkStatusLink")}
    </a>
  )
  if (block) {
    return (
      <>
        <p className="text-base-content/70">{body}</p>
        {link}
      </>
    )
  }
  return (
    <>
      {body} {link}
    </>
  )
}
