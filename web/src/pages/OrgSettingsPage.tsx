import { useEffect, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { Button, EmphasisLtr, Input, MonoLtr, rtlFlip } from "@/components/ui"
import PageShell from "@/components/PageShell"
import PageHeader, { OrgLink } from "@/components/PageHeader"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useParams } from "@tanstack/react-router"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { useSaveServiceToken } from "@/hooks/mutations/useSaveServiceToken"
import useGetServiceTokenStatus from "@/hooks/useGetServiceTokenStatus"
import RequireRole from "@/components/RequireRole"
import OrgPolicyAuditPane from "@/pages/orgSettings/OrgPolicyAuditPane"
import RerunOrgSetup from "@/pages/orgSettings/RerunOrgSetup"
import TeardownSection from "@/pages/orgSettings/TeardownSection"
import SettingsSection from "@/pages/orgSettings/SettingsSection"
import { githubOrgSettingsUrl } from "@/util/orgUrl"
import { CalloutDiv } from "@/lib/motionComponents"
import {
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  TriangleAlert,
} from "lucide-react"

const DEFAULT_EXPIRY_DAYS = 120
const MIN_EXPIRY_DAYS = 1

// GitHub rejects a fine-grained PAT *name* over 40 chars, so the prefill must
// fit. We don't interpolate the org (most slugs overflow) — the prefilled
// target_name and description identify the org instead.
const GITHUB_TOKEN_NAME_MAX = 40

// Guarded at module load so a future edit overflowing the 40-char limit fails
// fast in dev/CI instead of shipping a name GitHub's form rejects.
const SERVICE_TOKEN_NAME = "Classroom 50 Actions Token"
if (SERVICE_TOKEN_NAME.length > GITHUB_TOKEN_NAME_MAX) {
  throw new Error(
    `Service token name "${SERVICE_TOKEN_NAME}" is ${SERVICE_TOKEN_NAME.length} chars; ` +
      `GitHub rejects PAT names longer than ${GITHUB_TOKEN_NAME_MAX}.`,
  )
}

// GitHub caps a token at one calendar year, so max days is 366 across a leap
// day, else 365. `from` proxies the token's start (GitHub's clock starts at
// "Generate"); pass a real start date here if we ever add a picker.
function maxExpiryDays(from: Date): number {
  const oneYearOut = new Date(from)
  oneYearOut.setFullYear(oneYearOut.getFullYear() + 1)
  const msPerDay = 24 * 60 * 60 * 1000
  return Math.round((oneYearOut.getTime() - from.getTime()) / msPerDay)
}

// One descriptor per service-token status, keeping the banner's style, icon,
// and titleKey in sync from a single source.
const TOKEN_STATUS_BANNER = {
  present: {
    className: "border-success/30 bg-success/10",
    Icon: CheckCircle2,
    iconClassName: "text-success",
    titleKey: "orgSettings.serviceToken.statusPresent",
  },
  missing: {
    className: "border-error/30 bg-error/10",
    Icon: TriangleAlert,
    iconClassName: "text-error",
    titleKey: "orgSettings.serviceToken.statusMissing",
  },
  unknown: {
    className: "border-warning/30 bg-warning/10",
    Icon: TriangleAlert,
    iconClassName: "text-warning",
    titleKey: "orgSettings.serviceToken.statusUnknown",
  },
} as const

export function ServiceTokenInfo() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      if (
        popupRef.current &&
        !popupRef.current.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
      }
    }

    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("keydown", handleKeyDown)

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [open])

  return (
    <div ref={popupRef} className="dropdown">
      <Button
        variant="ghost"
        shape="circle"
        size="xs"
        className="text-base-content/70 hover:text-base-content"
        aria-label={t("orgSettings.serviceToken.infoAria")}
        aria-expanded={open}
        onClick={() => setOpen((open) => !open)}
      >
        <span className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[11px] font-bold">
          i
        </span>
      </Button>

      {open && (
        <div className="dropdown-content z-50 mt-2 w-80 rounded-box border border-base-300 bg-base-100 p-4 text-sm shadow-xl">
          <p className="text-base-content/70">
            <Trans
              i18nKey="orgSettings.serviceToken.info"
              components={{
                secret: <MonoLtr className="text-xs" />,
                repo: <EmphasisLtr />,
              }}
            />
          </p>
        </div>
      )}
    </div>
  )
}

export const OrgSettingsPane = () => {
  const { t } = useTranslation()
  const runPat = useSafeSubmit()
  const { org } = useParams({ strict: false })
  const [serviceToken, setServiceToken] = useState("")
  const [savedKind, setSavedKind] = useState<null | "saved" | "updated">(null)
  const [expiryDays, setExpiryDays] = useState(String(DEFAULT_EXPIRY_DAYS))
  const tokenInputRef = useRef<HTMLInputElement>(null)
  const expiryInputRef = useRef<HTMLInputElement>(null)

  const { data: tokenStatus, isLoading: tokenStatusLoading } =
    useGetServiceTokenStatus(org ?? "")
  const tokenAlreadySet = tokenStatus?.status === "present"

  // When a token is set, collapse the config fields by default; when
  // missing/unknown they stay expanded. `manualOpen` lets the user override
  // once they interact; until then it follows the token status.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const configOpen = manualOpen ?? !tokenAlreadySet

  const [now] = useState(() => Date.now())

  const maxExpiry = maxExpiryDays(new Date(now))

  const parsedExpiry = Number(expiryDays)
  const expiryValid =
    Number.isInteger(parsedExpiry) &&
    parsedExpiry >= MIN_EXPIRY_DAYS &&
    parsedExpiry <= maxExpiry

  const expiresDate = expiryValid
    ? new Date(now + parsedExpiry * 24 * 60 * 60 * 1000)
    : null

  const serviceTokenUrl =
    "https://github.com/settings/personal-access-tokens/new?" +
    new URLSearchParams({
      name: SERVICE_TOKEN_NAME,
      description: t("orgSettings.serviceToken.patDescription", { org }),
      target_name: org ?? "",
      expires_in: String(expiryValid ? parsedExpiry : DEFAULT_EXPIRY_DAYS),
      contents: "write",
      actions: "write",
      // Repository Administration: write. Collection grants staff teams (e.g.
      // TAs) read access to student repos and private templates via
      // PUT /orgs/{org}/teams/{slug}/repos/... — NOT implied by Contents.
      administration: "write",
      // Org-level Members: Read. Collection is team-driven (it lists the
      // classroom team's members), which needs this org permission and is NOT
      // implied by any repo scope. GitHub only honors the `members` prefill
      // when target_name is an org (it is, above).
      members: "read",
    }).toString()

  const patMutation = useSaveServiceToken(org)

  return (
    <SettingsSection
      title={t("orgSettings.serviceToken.title")}
      titleAdornment={<ServiceTokenInfo />}
    >
      {!tokenStatusLoading &&
        tokenStatus &&
        (() => {
          const banner = TOKEN_STATUS_BANNER[tokenStatus.status]
          const { Icon } = banner
          return (
            <CalloutDiv
              className={[
                "flex items-start gap-3 rounded-xl border p-4 text-sm",
                banner.className,
              ].join(" ")}
            >
              <Icon
                className={`mt-0.5 size-5 shrink-0 ${banner.iconClassName}`}
              />
              <div className="min-w-0">
                <p className="font-semibold text-base-content">
                  {t(banner.titleKey)}
                </p>
                <p className="mt-1 text-base-content/70">
                  {tokenStatus.message}
                </p>
                {tokenStatus.status === "present" && (
                  <p className="mt-1 text-base-content/70">
                    {t("orgSettings.serviceToken.replaceNote")}
                  </p>
                )}
              </div>
            </CalloutDiv>
          )
        })()}

      {tokenAlreadySet && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-4 gap-1"
          aria-expanded={configOpen}
          onClick={() => setManualOpen(!configOpen)}
        >
          {configOpen ? (
            <ChevronUp aria-hidden="true" className="size-4" />
          ) : (
            <ChevronRight aria-hidden="true" className={`size-4 ${rtlFlip}`} />
          )}
          {configOpen
            ? t("orgSettings.serviceToken.hideConfig")
            : t("orgSettings.serviceToken.updateOrReplace")}
        </Button>
      )}

      {configOpen && (
        <>
          <div className="mt-5">
            <label
              htmlFor="token-expiry"
              className="block text-sm font-semibold"
            >
              {t("orgSettings.serviceToken.expiryLabel")}
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label
                className={[
                  "input input-bordered flex w-36 items-center gap-2",
                  expiryValid ? "" : "input-error",
                ].join(" ")}
              >
                <input
                  id="token-expiry"
                  ref={expiryInputRef}
                  type="number"
                  min={MIN_EXPIRY_DAYS}
                  max={maxExpiry}
                  value={expiryDays}
                  onChange={(e) => setExpiryDays(e.target.value)}
                  className="w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-sm text-base-content/70">
                  {t("orgSettings.serviceToken.days")}
                </span>
              </label>

              {expiresDate ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-base-200 px-3 py-1 text-xs text-base-content/70">
                  <CalendarClock aria-hidden="true" className="size-3.5" />
                  {t("orgSettings.serviceToken.expiresOn", {
                    date: expiresDate.toLocaleDateString(),
                  })}
                </span>
              ) : (
                <span className="text-xs text-error">
                  {t("orgSettings.serviceToken.enterRange", {
                    min: MIN_EXPIRY_DAYS,
                    max: maxExpiry,
                  })}
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-base-content/70">
              {t("orgSettings.serviceToken.validRange", {
                min: MIN_EXPIRY_DAYS,
                max: maxExpiry,
              })}
            </p>
          </div>

          <a
            className={[
              "btn btn-primary mt-4",
              expiryValid ? "" : "btn-disabled",
            ].join(" ")}
            href={serviceTokenUrl}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!expiryValid}
            onClick={(e) => {
              // aria-disabled is visual only; also block activation so an
              // invalid expiry can't navigate to GitHub with the silent default.
              if (!expiryValid) {
                e.preventDefault()
                expiryInputRef.current?.focus()
                return
              }
              // Focus the token field so the user can paste on return.
              window.setTimeout(() => tokenInputRef.current?.focus(), 0)
            }}
          >
            <ExternalLink aria-hidden="true" className="size-4" />
            {t("orgSettings.serviceToken.generateOnGitHub")}
          </a>
          <p className="mt-2 text-xs text-base-content/70">
            <Trans
              i18nKey="orgSettings.serviceToken.generateHint"
              components={{
                permissions: <span className="font-semibold" />,
              }}
            />
          </p>

          <div className="mt-3 rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm">
            <p className="font-semibold text-base-content">
              {t("orgSettings.serviceToken.beforeGenerating")}
            </p>
            <ul className="mt-2 list-disc space-y-1 ps-5 text-base-content/80">
              <li>
                <Trans
                  i18nKey="orgSettings.serviceToken.repoAccess"
                  components={{
                    field: <span className="font-semibold" />,
                    value: <span className="font-semibold" />,
                    note: <span className="text-base-content/70" />,
                  }}
                />
              </li>
              <li>
                <Trans
                  i18nKey="orgSettings.serviceToken.permissions"
                  components={{
                    field: <span className="font-semibold" />,
                    perm: <span className="font-semibold" />,
                    note: <span className="text-base-content/70" />,
                  }}
                />
              </li>
            </ul>
            <p className="mt-3 text-base-content/80">
              {t("orgSettings.serviceToken.rotateNote")}
            </p>
          </div>

          <p className="mt-3 text-sm text-base-content/70">
            {t("orgSettings.serviceToken.pasteBelow")}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!patMutation.isPending)
                void runPat(() =>
                  patMutation.mutateAsync(serviceToken, {
                    onSuccess: () => {
                      setServiceToken("")
                      setSavedKind(tokenAlreadySet ? "updated" : "saved")
                    },
                  }),
                )
            }}
          >
            <div className="flex flex-col gap-2 w-full pb-10">
              <label
                htmlFor="service-token"
                className="label font-bold mt-4 text-sm"
              >
                {tokenAlreadySet
                  ? t("orgSettings.serviceToken.enterNewLabel")
                  : t("orgSettings.serviceToken.enterLabel")}
              </label>
              <Input
                id="service-token"
                ref={tokenInputRef}
                type="password"
                placeholder={t("orgSettings.serviceToken.placeholder")}
                autoComplete="off"
                value={serviceToken}
                onChange={(e) => {
                  setServiceToken(e.target.value)
                  setSavedKind(null)
                  if (patMutation.isError) patMutation.reset()
                }}
              />
              <p className="text-xs text-base-content/70">
                <Trans
                  i18nKey="orgSettings.serviceToken.validateHint"
                  components={{
                    value: <span className="font-semibold" />,
                  }}
                />
              </p>
              {patMutation.isError && (
                <div className="flex items-start gap-2 rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error">
                  <TriangleAlert
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0"
                  />
                  <span>
                    {patMutation.error instanceof Error
                      ? patMutation.error.message
                      : t("orgSettings.serviceToken.saveError")}
                  </span>
                </div>
              )}
              {savedKind && (
                <p className="flex items-center gap-1 text-sm text-success">
                  <CheckCircle2 aria-hidden="true" className="size-4" />
                  {savedKind === "updated"
                    ? t("orgSettings.serviceToken.savedUpdated")
                    : t("orgSettings.serviceToken.savedNew")}
                </p>
              )}
              <Button
                variant="primary"
                type="submit"
                className="self-end mt-2"
                loading={patMutation.isPending}
                loadingLabel={t("orgSettings.serviceToken.validating")}
                disabled={patMutation.isPending || !serviceToken}
              >
                {patMutation.isPending
                  ? t("orgSettings.serviceToken.validating")
                  : tokenAlreadySet
                    ? t("orgSettings.serviceToken.updateButton")
                    : t("orgSettings.serviceToken.saveButton")}
              </Button>
            </div>
          </form>
        </>
      )}
    </SettingsSection>
  )
}

const OrgSettingsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.organizationSettings"))
  const { org } = useParams({ strict: false })

  return (
    <PageShell page="classes" settings selected="settings">
      <RequireRole allow="owner">
        <PageHeader
          title={t("orgSettings.page.heading")}
          subtitle={
            <Trans
              i18nKey="orgSettings.page.subheading"
              values={{ org: org ?? "" }}
              components={{
                orgLink: (
                  <OrgLink
                    org={org}
                    href={githubOrgSettingsUrl(org ?? "")}
                    title={t("common.openOrgOnGitHub", { org })}
                  />
                ),
              }}
            />
          }
        />
        <div className="mt-8 space-y-8">
          <OrgSettingsPane />
          {org && <OrgPolicyAuditPane key={org} org={org} />}
          {org && <RerunOrgSetup org={org} />}
          {org && <TeardownSection org={org} />}
        </div>
      </RequireRole>
    </PageShell>
  )
}

export default OrgSettingsPage
