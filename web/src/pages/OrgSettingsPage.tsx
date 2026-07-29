import { useEffect, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { Button, HelpTooltip, Input, Modal, cx } from "@/components/ui"
import PageShell from "@/components/PageShell"
import PageHeader, { OrgLink } from "@/components/PageHeader"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { useParams, useSearch, useNavigate } from "@tanstack/react-router"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { useSaveServiceToken } from "@/hooks/mutations/useSaveServiceToken"
import { useRenameServiceToken } from "@/hooks/mutations/useRenameServiceToken"
import useGetServiceTokenStatus from "@/hooks/useGetServiceTokenStatus"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import { serviceTokenName, randomTokenHash } from "@/util/serviceTokenName"
import { useToast } from "@/context/notifications/NotificationProvider"
import RequireRole from "@/components/RequireRole"
import OrgPolicyAuditPane from "@/pages/orgSettings/OrgPolicyAuditPane"
import OrgActionsSection from "@/pages/orgSettings/OrgActionsSection"
import RerunOrgSetup from "@/pages/orgSettings/RerunOrgSetup"
import TeardownSection from "@/pages/orgSettings/TeardownSection"
import SettingsSection from "@/pages/orgSettings/SettingsSection"
import { githubOrgSettingsUrl } from "@/util/orgUrl"
import { WIKI_URL } from "@/version"
import {
  CalendarClock,
  Check,
  CheckCircle2,
  ExternalLink,
  Pencil,
  TriangleAlert,
  X,
} from "lucide-react"

// Default token lifetime (days) prefilled into GitHub's form. The user can edit
// it in the modal within GitHub's allowed range; we record the chosen value so
// the app can show an expiry countdown.
const DEFAULT_EXPIRY_DAYS = 120
const MIN_EXPIRY_DAYS = 1

// GitHub caps a fine-grained PAT at one calendar year, so the max is 366 across
// a leap day, else 365. `from` proxies the token's start (GitHub's clock starts
// at "Generate").
function maxExpiryDays(from: Date): number {
  const oneYearOut = new Date(from)
  oneYearOut.setFullYear(oneYearOut.getFullYear() + 1)
  const msPerDay = 24 * 60 * 60 * 1000
  return Math.round((oneYearOut.getTime() - from.getTime()) / msPerDay)
}

// The prefilled GitHub fine-grained-PAT creation URL for this org: name,
// resource owner, expiry, and the exact scopes collection/regrade need. The
// detailed "why these scopes / set All repositories" guidance lives in a
// tooltip in the modal rather than on the page.
function buildServiceTokenUrl(
  org: string | undefined,
  tokenName: string,
  description: string,
  expiresInDays: number,
): string {
  return (
    "https://github.com/settings/personal-access-tokens/new?" +
    new URLSearchParams({
      name: tokenName || "classroom50-token",
      description,
      target_name: org ?? "",
      expires_in: String(expiresInDays),
      contents: "write",
      actions: "write",
      // Administration: write — collection grants staff teams read on student
      // repos/templates (PUT teams/.../repos/...), not implied by Contents.
      administration: "write",
      // Members: Read — collection lists the classroom team; an org permission,
      // honored only when target_name is an org (it is).
      members: "read",
    }).toString()
  )
}

// The rename affordance for the token's stored display label: an inline pencil
// that opens an input + save/cancel. Label-only — it does not rename the actual
// GitHub PAT (whose name isn't API-writable).
function TokenNameRow({
  storedName,
  renameMutation,
}: {
  storedName: string
  renameMutation: ReturnType<typeof useRenameServiceToken>
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(storedName)

  const beginEdit = () => {
    setDraft(storedName)
    renameMutation.reset()
    setEditing(true)
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-base-content/60">
          {t("orgSettings.serviceToken.nameRowLabel")}
        </span>
        <span className="font-mono text-base-content/90">{storedName}</span>
        <HelpTooltip help={t("orgSettings.serviceToken.nameHelp")} />
        <Button
          variant="ghost"
          size="xs"
          shape="circle"
          aria-label={t("orgSettings.serviceToken.rename")}
          onClick={beginEdit}
        >
          <Pencil aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (renameMutation.isPending || !draft.trim()) return
        renameMutation.mutate(draft, { onSuccess: () => setEditing(false) })
      }}
    >
      <Input
        className="w-64 font-mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        aria-label={t("orgSettings.serviceToken.nameRowLabel")}
      />
      <Button
        variant="primary"
        size="sm"
        shape="circle"
        type="submit"
        aria-label={t("orgSettings.serviceToken.saveName")}
        loading={renameMutation.isPending}
        disabled={renameMutation.isPending || !draft.trim()}
      >
        <Check aria-hidden="true" className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        shape="circle"
        type="button"
        aria-label={t("orgSettings.serviceToken.cancelRename")}
        onClick={() => setEditing(false)}
      >
        <X aria-hidden="true" className="size-4" />
      </Button>
      {renameMutation.isError && (
        <span className="text-xs text-error">
          {renameMutation.error instanceof Error
            ? renameMutation.error.message
            : t("orgSettings.serviceToken.saveError")}
        </span>
      )}
    </form>
  )
}

// The set/rotate modal: paste a token plus a "Generate new access token" button
// that opens the prefilled GitHub form. Re-focusing the tab (after the user
// returns from generating on GitHub) auto-focuses the paste field.
function SetTokenModal({
  open,
  onClose,
  org,
  tokenName,
  saveMutation,
}: {
  open: boolean
  onClose: () => void
  org: string | undefined
  tokenName: string
  saveMutation: ReturnType<typeof useSaveServiceToken>
}) {
  const { t } = useTranslation()
  const runPat = useSafeSubmit()
  const [token, setToken] = useState("")
  const [expiryDays, setExpiryDays] = useState(String(DEFAULT_EXPIRY_DAYS))
  const inputRef = useRef<HTMLInputElement>(null)

  const [now] = useState(() => Date.now())
  const maxExpiry = maxExpiryDays(new Date(now))
  const parsedExpiry = Number(expiryDays)
  const expiryValid =
    Number.isInteger(parsedExpiry) &&
    parsedExpiry >= MIN_EXPIRY_DAYS &&
    parsedExpiry <= maxExpiry

  const url = buildServiceTokenUrl(
    org,
    tokenName,
    t("orgSettings.serviceToken.patDescription", { org }),
    expiryValid ? parsedExpiry : DEFAULT_EXPIRY_DAYS,
  )

  // On return from GitHub's token page (tab/window regains focus), drop the
  // cursor into the paste field — but only if it's still empty AND focus isn't
  // already inside the modal, so a user mid-editing the expiry field (or who
  // alt-tabbed away and back) isn't yanked out of what they were typing.
  useEffect(() => {
    if (!open) return
    const focusInput = () => {
      const input = inputRef.current
      if (!input) return
      if (input.value) return
      const active = document.activeElement
      if (active && active !== document.body && active !== input) return
      input.focus()
    }
    window.addEventListener("focus", focusInput)
    return () => window.removeEventListener("focus", focusInput)
  }, [open])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      aria-label={t("orgSettings.serviceToken.setModalTitle")}
      closeDisabled={saveMutation.isPending}
    >
      <h3 className="text-lg font-semibold">
        {t("orgSettings.serviceToken.setModalTitle")}
      </h3>

      <div className="mt-4">
        <label htmlFor="token-expiry" className="label pb-1 font-semibold">
          {t("orgSettings.serviceToken.expiryLabel")}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label
            className={cx(
              "input input-bordered flex w-32 items-center gap-2",
              expiryValid ? "" : "input-error",
            )}
          >
            <input
              id="token-expiry"
              type="number"
              inputMode="numeric"
              min={MIN_EXPIRY_DAYS}
              max={maxExpiry}
              value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value)}
              className="w-full [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-sm text-base-content/60">
              {t("orgSettings.serviceToken.days")}
            </span>
          </label>
          {expiryValid ? (
            <span className="text-xs text-base-content/60">
              {t("orgSettings.serviceToken.expiresOn", {
                date: new Date(
                  now + parsedExpiry * 24 * 60 * 60 * 1000,
                ).toLocaleDateString(),
              })}
            </span>
          ) : (
            <span className="text-xs text-error">
              {t("orgSettings.serviceToken.expiryRange", {
                min: MIN_EXPIRY_DAYS,
                max: maxExpiry,
              })}
            </span>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-1.5">
          <a
            className={cx(
              "btn btn-outline btn-sm gap-1",
              expiryValid ? "" : "btn-disabled",
            )}
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!expiryValid}
            onClick={(e) => {
              // aria-disabled is visual only; also block activation so an
              // invalid expiry can't open GitHub's form with the silent default.
              if (!expiryValid) e.preventDefault()
            }}
          >
            <ExternalLink aria-hidden="true" className="size-4" />
            {t("orgSettings.serviceToken.generateOnGitHub")}
          </a>
          <HelpTooltip
            help={t("orgSettings.serviceToken.generateHelp")}
            position="top"
          />
        </div>
        <a
          className="link link-primary inline-flex items-center gap-1 text-sm"
          href={`${WIKI_URL}/GitHub-Integration#4-fine-grained-pat-for-score-collection`}
          target="_blank"
          rel="noreferrer"
        >
          {t("orgSettings.serviceToken.learnMore")}
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      </div>

      <form
        className="mt-4 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          // Require a valid expiry as well as a token: saving with an invalid
          // expiry would pass `expiresInDays: undefined` and leave the PREVIOUS
          // token's expiry variable in place, so the health chip would then
          // describe the newly-rotated token with a stale date.
          if (saveMutation.isPending || !token.trim() || !expiryValid) return
          void runPat(() =>
            saveMutation.mutateAsync(
              {
                serviceToken: token,
                expiresInDays: parsedExpiry,
                tokenName: tokenName || undefined,
              },
              { onSuccess: onClose },
            ),
          )
        }}
      >
        <div className="flex items-center gap-1.5">
          <label htmlFor="service-token" className="label font-semibold">
            {t("orgSettings.serviceToken.pasteLabel")}
          </label>
          <HelpTooltip
            help={t("orgSettings.serviceToken.pasteHelp")}
            position="right"
          />
        </div>
        <Input
          id="service-token"
          ref={inputRef}
          type="password"
          placeholder={t("orgSettings.serviceToken.placeholder")}
          autoComplete="off"
          value={token}
          onChange={(e) => {
            setToken(e.target.value)
            if (saveMutation.isError) saveMutation.reset()
          }}
        />

        {saveMutation.isError && (
          <p className="flex items-start gap-2 text-sm text-error">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0"
            />
            <span>
              {saveMutation.error instanceof Error
                ? saveMutation.error.message
                : t("orgSettings.serviceToken.saveError")}
            </span>
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            loading={saveMutation.isPending}
            loadingLabel={t("orgSettings.serviceToken.validating")}
            disabled={saveMutation.isPending || !token.trim() || !expiryValid}
          >
            {t("orgSettings.serviceToken.saveButton")}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export const OrgSettingsPane = () => {
  const { t } = useTranslation()
  const { org } = useParams({ strict: false })
  const search = useSearch({ strict: false }) as { focus?: string }
  const navigate = useNavigate()
  const { notify } = useToast()

  const { data: tokenStatus, isLoading: tokenStatusLoading } =
    useGetServiceTokenStatus(org ?? "")
  const present = tokenStatus?.status === "present"
  const storedName = present ? tokenStatus.tokenName : undefined
  const expiresAt = present ? tokenStatus.expiresAt : undefined
  const expiresDate =
    expiresAt && !Number.isNaN(Date.parse(expiresAt))
      ? new Date(expiresAt)
      : null

  // The org's numeric id anchors the default token name; the random 4-char hash
  // is drawn once per mount so the prefilled name is stable across renders.
  const { data: orgDetails } = useGetOrgPlanDetails(org)
  const [nameHash] = useState(() => randomTokenHash())
  // Always prefill a FRESH unique name (org id + a new random hash), even when
  // rotating: GitHub rejects a new fine-grained PAT whose name collides with an
  // existing one on the same account, and a rotation is a brand-new PAT while
  // the old one is (usually) still listed. The stored name stays the rename
  // default (TokenNameRow), but the generate flow must not reuse it.
  const prefillName = orgDetails?.id
    ? serviceTokenName(orgDetails.id, nameHash)
    : ""

  const saveMutation = useSaveServiceToken(org)
  const renameMutation = useRenameServiceToken(org)

  const [modalOpen, setModalOpen] = useState(false)

  // Deep-link from the org list's token-health chip (`?focus=serviceToken`):
  // scroll the section into view, highlight it, and open the set-token modal so
  // a multi-org teacher lands directly on the rotate flow. Runs once on mount,
  // then strips the param (replace) so the one-shot link is consumed exactly
  // once — a later remount (navigate away and back, refresh) or a dismissal
  // won't re-pop the modal or leave a stale ?focus in history.
  const focusServiceToken = search?.focus === "serviceToken"
  const [highlight, setHighlight] = useState(false)
  useEffect(() => {
    if (!focusServiceToken) return
    setHighlight(true)
    setModalOpen(true)
    document
      .getElementById("service-token-section")
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
    void navigate({
      to: ".",
      search: (prev) => ({ ...prev, focus: undefined }),
      replace: true,
    })
    const id = window.setTimeout(() => setHighlight(false), 2000)
    return () => window.clearTimeout(id)
  }, [focusServiceToken, navigate])

  const openModal = () => {
    saveMutation.reset()
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    if (saveMutation.isSuccess) {
      // A successful token save whose advisory expiry/name write failed is still
      // a real save, but the expiry/name won't read back — say so rather than a
      // clean "saved", so the teacher isn't misled by a later "expiry not
      // tracked" chip.
      if (saveMutation.data && saveMutation.data.metadataRecorded === false) {
        notify({
          tone: "warning",
          message: t("orgSettings.serviceToken.savedNoMetadata"),
        })
      } else {
        notify({
          tone: "success",
          message: t("orgSettings.serviceToken.saved"),
        })
      }
    }
  }

  return (
    <SettingsSection
      id="service-token-section"
      title={t("orgSettings.serviceToken.title")}
      titleAdornment={<HelpTooltip help={t("orgSettings.serviceToken.help")} />}
      className={
        highlight
          ? "ring-2 ring-primary ring-offset-2 ring-offset-base-100 transition-shadow"
          : "transition-shadow"
      }
    >
      {tokenStatusLoading ? (
        <p className="text-sm text-base-content/60">
          {t("orgSettings.serviceToken.checking")}
        </p>
      ) : !present ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-error">
            <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
            {t("orgSettings.serviceToken.statusMissing")}
          </span>
          <Button variant="primary" size="sm" onClick={openModal}>
            {t("orgSettings.serviceToken.setButton")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-2 text-success">
                <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
                {t("orgSettings.serviceToken.statusPresent")}
              </span>
              {expiresDate && (
                <span className="inline-flex items-center gap-1.5 text-base-content/60">
                  <CalendarClock
                    aria-hidden="true"
                    className="size-3.5 shrink-0"
                  />
                  {t("orgSettings.serviceToken.expiresOn", {
                    date: expiresDate.toLocaleDateString(),
                  })}
                </span>
              )}
            </span>
            <Button variant="outline" size="sm" onClick={openModal}>
              {t("orgSettings.serviceToken.rotateButton")}
            </Button>
          </div>

          {storedName && (
            <TokenNameRow
              storedName={storedName}
              renameMutation={renameMutation}
            />
          )}
        </div>
      )}

      <SetTokenModal
        // Remount on every open/close so the modal's internal state resets: the
        // paste field, the chosen expiry, and the frozen `now` clock (used for
        // the max-expiry bound). Without the key those would persist a stale
        // value across a second open.
        key={modalOpen ? "open" : "closed"}
        open={modalOpen}
        onClose={closeModal}
        org={org}
        tokenName={prefillName}
        saveMutation={saveMutation}
      />
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
          {org && <OrgActionsSection key={`actions-${org}`} org={org} />}
          {org && <OrgPolicyAuditPane key={org} org={org} />}
          {org && <RerunOrgSetup org={org} />}
          {org && <TeardownSection org={org} />}
        </div>
      </RequireRole>
    </PageShell>
  )
}

export default OrgSettingsPage
