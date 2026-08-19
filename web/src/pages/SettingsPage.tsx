import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useHiddenOrgs } from "@/context/hiddenOrgs/HiddenOrgsProvider"
import {
  Button,
  Card,
  RouterButton,
  SectionAnchorHeading,
  cx,
} from "@/components/ui"
import { useTranslation } from "react-i18next"
import { useMemo } from "react"
import useGetOrgs from "@/hooks/useGetOrgs"
import {
  isOwnedReadyOrg,
  useOrgServiceTokenHealth,
} from "@/hooks/useOrgServiceTokenHealth"
import {
  useHashSectionHighlight,
  sectionHighlightClass,
} from "@/hooks/useHashSectionHighlight"
import { TokenHealthChip } from "@/components/status/TokenHealthChip"
import { useReducedMotion, type MotionPref } from "@/hooks/useReducedMotion"
import { useTheme, type ThemePref } from "@/hooks/useTheme"
import { LanguageSwitcher } from "@/components/settings/LanguageSwitcher"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useHasDeleteRepoScope } from "@/context/github/GitHubProvider"

// Owned + Classroom 50-ready orgs are the only ones with a manageable service
// token (a non-owner can't read/set it). The section reads token health for
// exactly this set.
function ServiceTokensSection({ highlighted }: { highlighted?: boolean }) {
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
    <SettingsSectionCard
      id="service-tokens"
      heading={t("settings.serviceTokens.heading")}
      subheading={t("settings.serviceTokens.subheading")}
      highlighted={highlighted}
    >
      {isLoading ? (
        <p className="text-sm text-base-content/60">
          {t("settings.serviceTokens.loading")}
        </p>
      ) : ownedReady.length === 0 ? (
        <p className="text-sm text-base-content/60">
          {t("settings.serviceTokens.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
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
                  hash="service-token"
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
    </SettingsSectionCard>
  )
}

// Least-privilege by default: normal sign-in never requests delete_repo, so a
// destructive action (Teardown Organization) needs a one-shot elevated re-auth.
// This is an action, not a persisted toggle: the scope *request* defaults to
// base on every sign-in (only this button asks for delete_repo, for that one
// re-auth), so a later plain sign-in drops back to base. The elevated token
// itself is stored like any OAuth token until sign-out — one-shot is about the
// request preference, not the token's lifetime (#655).
function ElevatedPermissionsSection({
  highlighted,
}: {
  highlighted?: boolean
}) {
  const { t } = useTranslation()
  const { startWebFlow } = useGithubAuth()
  const hasDeleteRepo = useHasDeleteRepoScope()

  return (
    <SettingsSectionCard
      id="elevated-permissions"
      heading={t("settings.elevatedScope.heading")}
      subheading={t("settings.elevatedScope.subheading")}
      highlighted={highlighted}
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-base-content/70">
          {hasDeleteRepo
            ? t("settings.elevatedScope.granted")
            : t("settings.elevatedScope.notGranted")}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => void startWebFlow({ elevated: true })}
        >
          {t("settings.elevatedScope.grantButton")}
        </Button>
      </div>
    </SettingsSectionCard>
  )
}

// A single-choice preference rendered as an accessible radio group. Shared by
// the Appearance and Animations sections (identical shape: labeled options with
// a hint, current value + setter). `name` scopes the radios so the two groups
// don't collide.
function PreferenceRadioGroup<T extends string>({
  name,
  legend,
  value,
  onChange,
  options,
}: {
  name: string
  legend: string
  value: T
  onChange: (next: T) => void
  options: { value: T; label: string; hint: string }[]
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const id = `${name}-${option.value}`
        const hintId = `${id}-hint`
        return (
          <label
            key={option.value}
            htmlFor={id}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-base-300 px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
          >
            <input
              id={id}
              type="radio"
              name={name}
              className="radio radio-sm radio-primary mt-0.5"
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              aria-label={option.label}
              aria-describedby={hintId}
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium">{option.label}</span>
              <span id={hintId} className="text-xs text-base-content/60">
                {option.hint}
              </span>
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}

// Card shell for a settings section: an anchor heading + subheading over its
// body. Matches the Service-tokens / Hidden-orgs sections.
function SettingsSectionCard({
  id,
  heading,
  subheading,
  highlighted,
  children,
}: {
  id: string
  heading: string
  subheading: string
  highlighted?: boolean
  children: React.ReactNode
}) {
  return (
    <Card
      id={id}
      radius="xl"
      shadow={false}
      className={cx(
        "scroll-mt-24",
        sectionHighlightClass(highlighted ?? false),
      )}
    >
      <Card.Body>
        <SectionAnchorHeading anchorId={id} as="h3" className="card-title">
          {heading}
        </SectionAnchorHeading>
        <p className="text-sm text-base-content/70">{subheading}</p>
        <div className="mt-4">{children}</div>
      </Card.Body>
    </Card>
  )
}

// Groups related setting cards under a small heading + description, so the page
// reads as clusters (Preferences, Organizations) rather than a flat list.
function SettingsGroup({
  heading,
  description,
  children,
}: {
  heading: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-lg font-semibold">{heading}</h2>
        <p className="text-sm text-base-content/60">{description}</p>
      </div>
      {children}
    </section>
  )
}

// Theme preference (System / Light / Dark), persisted per-browser via useTheme.
// "System" follows the OS `prefers-color-scheme`. Mirrored quick-access toggle
// lives in the sidebar footer.
function AppearanceSection({ highlighted }: { highlighted?: boolean }) {
  const { t } = useTranslation()
  const { pref, setThemePref } = useTheme()

  const options: { value: ThemePref; label: string; hint: string }[] = [
    {
      value: "system",
      label: t("settings.appearance.system"),
      hint: t("settings.appearance.systemHint"),
    },
    {
      value: "sumi",
      label: t("settings.appearance.light"),
      hint: t("settings.appearance.lightHint"),
    },
    {
      value: "sumi-dark",
      label: t("settings.appearance.dark"),
      hint: t("settings.appearance.darkHint"),
    },
  ]

  return (
    <SettingsSectionCard
      id="appearance"
      heading={t("settings.appearance.heading")}
      subheading={t("settings.appearance.subheading")}
      highlighted={highlighted}
    >
      <PreferenceRadioGroup
        name="theme-pref"
        legend={t("settings.appearance.groupAria")}
        value={pref}
        onChange={setThemePref}
        options={options}
      />
    </SettingsSectionCard>
  )
}

// Language + language-pack management. Reuses the same LanguageSwitcher the
// profile-menu Language dialog renders, so the two stay in lockstep.
function LanguageSection({ highlighted }: { highlighted?: boolean }) {
  const { t } = useTranslation()
  return (
    <SettingsSectionCard
      id="language"
      heading={t("settings.language.heading")}
      subheading={t("settings.language.subheading")}
      highlighted={highlighted}
    >
      <LanguageSwitcher />
    </SettingsSectionCard>
  )
}

// Interface-motion preference (System / On / Off), persisted per-browser via
// useReducedMotion. The hook drives both the CSS (<html data-reduce-motion>)
// and Motion JS layers.
function MotionSection({ highlighted }: { highlighted?: boolean }) {
  const { t } = useTranslation()
  const { pref, setPref } = useReducedMotion()

  const options: { value: MotionPref; label: string; hint: string }[] = [
    {
      value: "system",
      label: t("settings.motion.system"),
      hint: t("settings.motion.systemHint"),
    },
    {
      value: "on",
      label: t("settings.motion.on"),
      hint: t("settings.motion.onHint"),
    },
    {
      value: "off",
      label: t("settings.motion.off"),
      hint: t("settings.motion.offHint"),
    },
  ]

  return (
    <SettingsSectionCard
      id="motion"
      heading={t("settings.motion.heading")}
      subheading={t("settings.motion.subheading")}
      highlighted={highlighted}
    >
      <PreferenceRadioGroup
        name="motion-pref"
        legend={t("settings.motion.groupAria")}
        value={pref}
        onChange={setPref}
        options={options}
      />
    </SettingsSectionCard>
  )
}

// Organizations hidden from the home page, with an Unhide affordance.
function HiddenOrgsSection({ highlighted }: { highlighted?: boolean }) {
  const { t } = useTranslation()
  const { hidden, unhide } = useHiddenOrgs()
  const hiddenLogins = [...hidden].sort((a, b) => a.localeCompare(b))

  return (
    <SettingsSectionCard
      id="hidden-orgs"
      heading={t("settings.hiddenOrgs.heading")}
      subheading={t("settings.hiddenOrgs.subheading")}
      highlighted={highlighted}
    >
      {hiddenLogins.length === 0 ? (
        <p className="text-sm text-base-content/60">
          {t("settings.hiddenOrgs.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {hiddenLogins.map((login) => (
            <li
              key={login}
              className="flex items-center justify-between gap-3 rounded-lg border border-base-300 px-3 py-2"
            >
              <span className="truncate font-mono text-sm font-semibold">
                {login}
              </span>
              <Button variant="outline" size="sm" onClick={() => unhide(login)}>
                {t("settings.hiddenOrgs.unhide")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSectionCard>
  )
}

// User settings scoped to this browser (client-side only), grouped into
// Organizations (hidden orgs, service tokens) and Preferences (animations,
// appearance, language). Groups and the cards within them are ordered
// alphabetically by their displayed heading. Theme and language also have
// quick-access affordances in the sidebar footer.
const SettingsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.settings"))
  const highlightedId = useHashSectionHighlight()

  return (
    <PageShell>
      <PageHeader
        title={t("settings.page.heading")}
        subtitle={t("settings.page.subheading")}
      />

      <div className="flex flex-col gap-8">
        <SettingsGroup
          heading={t("settings.groups.organizations")}
          description={t("settings.groups.organizationsDescription")}
        >
          <HiddenOrgsSection highlighted={highlightedId === "hidden-orgs"} />
          <ServiceTokensSection
            highlighted={highlightedId === "service-tokens"}
          />
          <ElevatedPermissionsSection
            highlighted={highlightedId === "elevated-permissions"}
          />
        </SettingsGroup>

        <SettingsGroup
          heading={t("settings.groups.preferences")}
          description={t("settings.groups.preferencesDescription")}
        >
          <MotionSection highlighted={highlightedId === "motion"} />
          <AppearanceSection highlighted={highlightedId === "appearance"} />
          <LanguageSection highlighted={highlightedId === "language"} />
        </SettingsGroup>
      </div>
    </PageShell>
  )
}

export default SettingsPage
