import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useHiddenOrgs } from "@/context/hiddenOrgs/HiddenOrgsProvider"
import { Button, Card, RouterButton } from "@/components/ui"
import { useTranslation } from "react-i18next"
import { useMemo } from "react"
import useGetOrgs from "@/hooks/useGetOrgs"
import {
  isOwnedReadyOrg,
  useOrgServiceTokenHealth,
} from "@/hooks/useOrgServiceTokenHealth"
import { TokenHealthChip } from "@/components/status/TokenHealthChip"

// Owned + Classroom 50-ready orgs are the only ones with a manageable service
// token (a non-owner can't read/set it). The section reads token health for
// exactly this set.
function ServiceTokensSection() {
  const { t } = useTranslation()
  const { data: orgs = [], isLoading } = useGetOrgs()

  const ownedReady = useMemo(
    () =>
      orgs
        .filter(isOwnedReadyOrg)
        .map((summary) => summary.org.login)
        .sort((a, b) => a.localeCompare(b)),
    [orgs],
  )

  const { byOrg } = useOrgServiceTokenHealth(ownedReady, !isLoading)

  return (
    <Card radius="xl" shadow={false}>
      <Card.Body>
        <Card.Title>{t("settings.serviceTokens.heading")}</Card.Title>
        <p className="text-sm text-base-content/70">
          {t("settings.serviceTokens.subheading")}
        </p>

        {isLoading ? (
          <p className="mt-4 text-sm text-base-content/60">
            {t("settings.serviceTokens.loading")}
          </p>
        ) : ownedReady.length === 0 ? (
          <p className="mt-4 text-sm text-base-content/60">
            {t("settings.serviceTokens.empty")}
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {ownedReady.map((login) => {
              const entry = byOrg[login]
              const expiresAgo =
                entry?.expiresAt && !Number.isNaN(Date.parse(entry.expiresAt))
                  ? new Date(entry.expiresAt).toLocaleDateString()
                  : undefined
              return (
                <li
                  key={login}
                  className="flex flex-col gap-2 rounded-lg border border-base-300 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-mono text-sm font-semibold">
                      {login}
                    </span>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-base-content/60">
                      {entry && (
                        <TokenHealthChip
                          org={login}
                          health={entry.health}
                          loading={entry.loading}
                        />
                      )}
                      {entry?.tokenName && (
                        <span className="font-mono">{entry.tokenName}</span>
                      )}
                      {expiresAgo && (
                        <span>
                          {t("settings.serviceTokens.expires", {
                            date: expiresAgo,
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                  <RouterButton
                    to="/$org/settings"
                    params={{ org: login }}
                    search={{ focus: "serviceToken" }}
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                  >
                    {t("settings.serviceTokens.manage")}
                  </RouterButton>
                </li>
              )
            })}
          </ul>
        )}
      </Card.Body>
    </Card>
  )
}

// User settings scoped to this browser (client-side only). Today it manages the
// set of organizations hidden from the home page; other per-browser prefs
// (theme, language) still live in the sidebar footer.
const SettingsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.settings"))
  const { hidden, unhide } = useHiddenOrgs()
  const hiddenLogins = [...hidden].sort((a, b) => a.localeCompare(b))

  return (
    <PageShell page="orgs" selected="settings">
      <PageHeader
        title={t("settings.page.heading")}
        subtitle={t("settings.page.subheading")}
      />

      <ServiceTokensSection />

      <Card radius="xl" shadow={false}>
        <Card.Body>
          <Card.Title>{t("settings.hiddenOrgs.heading")}</Card.Title>
          <p className="text-sm text-base-content/70">
            {t("settings.hiddenOrgs.subheading")}
          </p>

          {hiddenLogins.length === 0 ? (
            <p className="mt-4 text-sm text-base-content/60">
              {t("settings.hiddenOrgs.empty")}
            </p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {hiddenLogins.map((login) => (
                <li
                  key={login}
                  className="flex items-center justify-between gap-3 rounded-lg border border-base-300 px-3 py-2"
                >
                  <span className="truncate font-mono text-sm font-semibold">
                    {login}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => unhide(login)}
                  >
                    {t("settings.hiddenOrgs.unhide")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card.Body>
      </Card>
    </PageShell>
  )
}

export default SettingsPage
