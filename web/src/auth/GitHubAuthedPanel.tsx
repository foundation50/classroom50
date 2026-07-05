import { CheckCircle } from "lucide-react"
import { useTranslation } from "react-i18next"

import type { GitHubUser } from "@/hooks/github/types"

export function GitHubAuthedPanel({
  user,
  onSignOut,
}: {
  user: GitHubUser | null
  onSignOut: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-5">
      {/* "Signed in" only once /user confirms the token is live; a stale token
          would otherwise read as valid here (#stale-token). The card renders a
          spinner instead while the profile is still loading, so this panel only
          sees a resolved user or a genuine failure. */}
      {user ? (
        <div className="alert alert-success items-start text-sm">
          <CheckCircle aria-hidden="true" className="size-4 shrink-0" />
          <span>{t("auth.signedInConfirmed")}</span>
        </div>
      ) : null}

      <div className="flex flex-col items-center gap-3 text-center">
        {user?.avatar_url ? (
          <img
            className="size-20 rounded-full border border-base-300 object-cover"
            src={user.avatar_url}
            alt=""
          />
        ) : (
          <div className="flex size-20 items-center justify-center rounded-full border border-base-300 bg-base-200 text-2xl opacity-70">
            ◉
          </div>
        )}

        {user ? (
          <div>
            <div className="text-xl font-bold tracking-tight">
              {user.name || user.login}
            </div>
            <div className="text-sm text-base-content/70">@{user.login}</div>
            {user.bio ? (
              <p className="mt-2 text-sm text-base-content/70">{user.bio}</p>
            ) : null}
          </div>
        ) : (
          <div className="text-sm text-base-content/70">
            {t("auth.profileUnavailable")}
          </div>
        )}
      </div>

      <div className="divider" />

      <button className="btn btn-outline w-full" onClick={onSignOut}>
        {t("auth.signOutClearToken")}
      </button>
    </div>
  )
}
