import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useHiddenOrgs } from "@/context/hiddenOrgs/HiddenOrgsProvider"
import { Button, Card } from "@/components/ui"
import { useTranslation } from "react-i18next"

// User settings scoped to this browser (client-side only). Today it manages the
// set of organizations hidden from the home page; other per-browser prefs
// (theme, language) still live in the sidebar footer.
const SettingsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.settings"))
  const { hidden, unhide } = useHiddenOrgs()
  const hiddenLogins = [...hidden].sort((a, b) => a.localeCompare(b))

  return (
    <PageShell page="orgs" selected="settings" settings>
      <PageHeader
        title={t("settings.page.heading")}
        subtitle={t("settings.page.subheading")}
      />

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
