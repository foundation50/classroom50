import { useTranslation } from "react-i18next"

import { githubOAuthGrantUrl } from "./constants"

// Link to this app's entry on GitHub's authorized-apps page. Signing in again
// only narrows this browser's token, so GitHub is the one place the grant itself
// goes away — shared so the two surfaces that offer it can't drift.
export function RevokeAccessLink() {
  const { t } = useTranslation()
  return (
    <a
      className="link text-xs"
      href={githubOAuthGrantUrl()}
      target="_blank"
      rel="noopener noreferrer"
    >
      {t("auth.elevated.revokeLink")}
    </a>
  )
}
