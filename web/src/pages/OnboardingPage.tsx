import {
  ArrowRight,
  CheckCircle2,
  GraduationCap,
  Loader2,
  Mail,
  UserPlus,
} from "lucide-react"
import { Spinner } from "@/components/Spinner"
import {
  Badge,
  Button,
  Card,
  EmphasisLtr,
  RouterButton,
  rtlFlip,
} from "@/components/ui"
import {
  MembershipError,
  classifyMembershipError,
} from "@/components/MembershipError"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { Link, useParams, useSearch, useRouter } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { useGithubAuth } from "@/auth/useGithubAuth"
import useGetOwnOrgMembership from "@/hooks/useGetOwnOrgMembership"
import { useAcceptAndVerifyMembership } from "@/hooks/mutations/useAcceptAndVerifyMembership"
import { isMembershipReadError } from "@/util/membershipReadError"
import { deriveOnboardingState } from "@/util/onboardingState"
import { EnterDiv } from "@/lib/motionComponents"

const OnboardNavbar = () => {
  const { t } = useTranslation()
  return (
    <div className="navbar bg-base-100 shadow-sm">
      <Link to="/">
        <div className="flex p-6 text-lg font-bold">
          <GraduationCap
            aria-hidden="true"
            className="size-8 text-primary me-2"
          />{" "}
          {t("nav.appName")}
        </div>
      </Link>
    </div>
  )
}

const OnboardCard = ({ children }: { children: React.ReactNode }) => (
  <Card
    radius="xl"
    shadow={false}
    className="w-200 max-w-[calc(100vw-2em)] p-8 m-auto mt-10"
  >
    {children}
  </Card>
)

const OnboardShell = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-screen bg-base-100">
    <OnboardNavbar />
    <OnboardCard>{children}</OnboardCard>
  </div>
)

// No membership record at all: the student was never invited. A pending invite
// is NOT this state (the hook auto-accepts it).
const NotInvited = ({
  org,
  classroom,
}: {
  org?: string
  classroom?: string
}) => {
  const { t } = useTranslation()
  return (
    <OnboardShell>
      <EnterDiv className="card-body gap-6">
        <div>
          <Badge ghost size="md" className="gap-2">
            <Mail aria-hidden="true" className="size-4" />
            {t("getStarted.badge")}
          </Badge>
          <h1 className="mt-6 text-2xl font-bold">
            {t("getStarted.notInvited.title")}
          </h1>
          <p className="mt-2 text-base text-base-content/70">
            <Trans
              i18nKey="getStarted.notInvited.body"
              values={{ org }}
              components={{
                org: <EmphasisLtr className="text-base-content" />,
              }}
            />
          </p>
        </div>

        <div className="rounded-2xl border border-base-300 bg-base-200/50 p-5">
          <div className="flex gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-base-300/40 text-base-content/70">
              <UserPlus aria-hidden="true" className="size-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-semibold text-base-content">
                {t("getStarted.notInvited.waitingTitle")}
              </h2>
              <p className="mt-2 leading-5 text-sm text-base-content/70">
                <Trans
                  i18nKey="getStarted.notInvited.waitingBody"
                  values={{ classroom }}
                  components={{
                    classroom: <EmphasisLtr className="text-base-content" />,
                  }}
                />
              </p>
            </div>
          </div>
        </div>
      </EnterDiv>
    </OnboardShell>
  )
}

const AllSet = ({
  org,
  classroom,
  returning,
  returnTo,
  onContinue,
}: {
  org?: string
  classroom?: string
  returning: boolean
  returnTo?: string
  onContinue: () => void
}) => {
  const { t } = useTranslation()
  return (
    <OnboardShell>
      <EnterDiv className="card-body gap-6">
        <div>
          <Badge tone="primary" size="md" className="gap-2">
            <Mail aria-hidden="true" className="size-4" />
            {t("getStarted.badge")}
          </Badge>
          <h1 className="mt-6 text-2xl font-bold">
            {t("getStarted.active.title")}
          </h1>
          {classroom && (
            <p className="mt-2 text-sm text-base-content/70">{classroom}</p>
          )}
        </div>
        <div className="rounded-2xl border border-success/20 bg-success/5 p-5">
          <div className="flex gap-3">
            <CheckCircle2
              aria-hidden="true"
              className="size-6 shrink-0 text-success"
            />
            <p className="text-sm text-base-content/70">
              {returning
                ? t("getStarted.active.takingBack")
                : t("getStarted.active.message")}
            </p>
          </div>
        </div>
        {returning && returnTo ? (
          <Button variant="primary" className="w-full" onClick={onContinue}>
            {t("getStarted.continueToAssignment")}
          </Button>
        ) : (
          org &&
          classroom && (
            <RouterButton
              to="/$org/$classroom"
              params={{ org, classroom }}
              variant="primary"
              className="w-full"
            >
              {t("getStarted.active.goToClassroom")}
              <ArrowRight aria-hidden="true" className={`size-4 ${rtlFlip}`} />
            </RouterButton>
          )
        )}
      </EnterDiv>
    </OnboardShell>
  )
}

// Show a "still checking…" hint + manual Retry once loading persists this
// long, so a GitHub lag never strands the student on an unbounded spinner.
const SLOW_AFTER_MS = 10_000

const OnboardingPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.getStarted"))
  const { org, classroom } = useParams({ strict: false })
  const { user } = useGithubAuth()
  // Where to send the student once they're an active org member (set by the
  // accept page). The route already validated it's a safe relative path.
  const search = useSearch({ strict: false }) as { returnTo?: string }
  const returnTo =
    typeof search.returnTo === "string" ? search.returnTo : undefined
  const router = useRouter()

  const {
    data: orgMembership,
    isLoading: loadingMembership,
    error: rawMembershipError,
    refetch: refetchMembership,
  } = useGetOwnOrgMembership(org)

  // A 404 from GET /user/memberships/orgs/{org} isn't a read *failure* — it's
  // GitHub's authoritative "no membership record" (student never invited).
  // Treat it as "no membership" so we fall through to the calm notInvited
  // screen, reserving the error screen for genuine read failures (403 / SSO /
  // transient). This remapping is scoped to /onboard.
  const membershipReadError = isMembershipReadError(rawMembershipError)

  const hasMembership = Boolean(orgMembership)
  const alreadyActive = orgMembership?.state === "active"

  // Fire accept/verify only when a pending membership record exists, isn't
  // active, and the read didn't error. The hook owns fire-once semantics.
  const shouldAccept = hasMembership && !alreadyActive && !membershipReadError
  const accept = useAcceptAndVerifyMembership({ org, enabled: shouldAccept })

  const active = alreadyActive || accept.isActive

  // Precedence: a read error (or accept failure) beats everything so a stale
  // "active" can't mask a failure; then active; then loading (initial read OR
  // accept/verify in flight); then notInvited (no record).
  const state = deriveOnboardingState({
    loadingMembership,
    membershipReadError,
    hasMembership,
    acceptError: accept.isError,
    active,
  })

  // A read error can't be fixed by re-running accept (it failed before any
  // pending record was seen), so refetch the membership query then; else re-run
  // accept/verify.
  const retry = membershipReadError
    ? () => void refetchMembership()
    : accept.retry

  // One-shot latch: fire once when membership first goes active, not on every
  // re-render (history.push stacks entries).
  const navigatedRef = useRef(false)
  useEffect(() => {
    if (state === "active" && returnTo && !navigatedRef.current) {
      navigatedRef.current = true
      // Raw internal path: preserves the accept link's ?k= verbatim; the router
      // applies the basepath.
      router.history.push(returnTo)
    }
  }, [state, returnTo, router])

  // Bounded "still checking…" timer for the loading state.
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (state !== "loading") {
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS)
    return () => clearTimeout(timer)
  }, [state])

  if (state === "loading") {
    return (
      <OnboardShell>
        <EnterDiv className="card-body items-center gap-6">
          <Spinner size="xl" label={t("getStarted.checking.title")} />
          <div className="text-center">
            <h1 className="text-xl font-bold">
              {t("getStarted.checking.title")}
            </h1>
            <p className="mt-2 text-sm text-base-content/70">
              {t("getStarted.checking.message", { org })}
            </p>
          </div>
          {slow && (
            <div className="w-full space-y-3">
              <p className="text-center text-sm text-base-content/70">
                {t("getStarted.checking.stillChecking")}
              </p>
              <Button variant="outline" className="w-full" onClick={retry}>
                <Loader2 aria-hidden="true" className="size-4" />
                {t("getStarted.checking.retry")}
              </Button>
            </div>
          )}
        </EnterDiv>
      </OnboardShell>
    )
  }

  if (state === "notInvited") {
    return <NotInvited org={org} classroom={classroom} />
  }

  if (state === "error") {
    // Mirror the precedence above: a read error takes priority, so classify it
    // over any accept error. (A 404 never reaches here — it maps to notInvited.)
    const err = membershipReadError ? rawMembershipError : accept.error
    const errorInfo = classifyMembershipError(err, {
      org,
      username: user?.login,
      membershipState: orgMembership?.state,
    })
    return (
      <OnboardShell>
        <MembershipError info={errorInfo} org={org} onRetry={retry} />
      </OnboardShell>
    )
  }

  return (
    <AllSet
      org={org}
      classroom={classroom}
      returning={Boolean(returnTo)}
      returnTo={returnTo}
      onContinue={() => returnTo && router.history.push(returnTo)}
    />
  )
}

export default OnboardingPage
