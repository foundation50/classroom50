import {
  CheckCircle2,
  GraduationCap,
  Loader2,
  Mail,
  UserPlus,
} from "lucide-react"
import { Spinner } from "@/components/Spinner"
import { MembershipError } from "@/components/MembershipError"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { Link, useParams, useSearch, useRouter } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useOnboardingState } from "@/hooks/onboarding/useOnboardingState"
import { EnterDiv } from "@/lib/motionComponents"

const OnboardNavbar = () => {
  const { t } = useTranslation()
  return (
    <div className="navbar bg-base-100 shadow-sm">
      <Link to="/">
        <div className="flex p-6 text-lg font-bold">
          <GraduationCap
            aria-hidden="true"
            className="size-8 text-primary mr-2"
          />{" "}
          {t("nav.appName")}
        </div>
      </Link>
    </div>
  )
}

const OnboardCard = ({ children }: { children: React.ReactNode }) => (
  <div className="card w-200 max-w-[calc(100vw-2em)] p-8 m-auto rounded-xl mt-10 border border-base-300">
    {children}
  </div>
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
          <span className="badge badge-ghost badge-soft gap-2">
            <Mail aria-hidden="true" className="size-4" />
            {t("getStarted.badge")}
          </span>
          <h1 className="mt-6 text-2xl font-bold">
            {t("getStarted.notInvited.title")}
          </h1>
          <p className="mt-2 text-base text-base-content/70">
            {t("getStarted.notInvited.body_prefix")}{" "}
            <span className="font-semibold text-base-content">{org}</span>{" "}
            {t("getStarted.notInvited.body_suffix")}
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
                {t("getStarted.notInvited.waitingBody_prefix")}{" "}
                <span className="font-semibold text-base-content">
                  {classroom}
                </span>
                {t("getStarted.notInvited.waitingBody_suffix")}
              </p>
            </div>
          </div>
        </div>
      </EnterDiv>
    </OnboardShell>
  )
}

const AllSet = ({
  classroom,
  returning,
  returnTo,
  onContinue,
}: {
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
          <span className="badge badge-primary badge-soft gap-2">
            <Mail aria-hidden="true" className="size-4" />
            {t("getStarted.badge")}
          </span>
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
        {returning && returnTo && (
          <button
            type="button"
            className="btn btn-primary w-full"
            onClick={onContinue}
          >
            {t("getStarted.continueToAssignment")}
          </button>
        )}
      </EnterDiv>
    </OnboardShell>
  )
}

// Surface a "still checking…" hint plus a manual Retry once the loading state
// has persisted this long, so a GitHub lag never strands the student on an
// unbounded spinner.
const SLOW_AFTER_MS = 10_000

const OnboardingPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.getStarted"))
  const { org, classroom } = useParams({ strict: false })
  // Where to send the student once they've become an active org member (set by
  // the accept page). The route already validated it's a safe relative path.
  const search = useSearch({ strict: false }) as { returnTo?: string }
  const returnTo =
    typeof search.returnTo === "string" ? search.returnTo : undefined
  const router = useRouter()

  const { state, errorInfo, retry } = useOnboardingState({ org, classroom })

  // One-shot latch: history.push stacks entries, so fire once when membership
  // first goes active rather than on every re-render.
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
              <button
                type="button"
                className="btn btn-outline w-full"
                onClick={retry}
              >
                <Loader2 aria-hidden="true" className="size-4" />
                {t("getStarted.checking.retry")}
              </button>
            </div>
          )}
        </EnterDiv>
      </OnboardShell>
    )
  }

  if (state === "notInvited") {
    return <NotInvited org={org} classroom={classroom} />
  }

  if (state === "error" && errorInfo) {
    return (
      <OnboardShell>
        <MembershipError info={errorInfo} org={org} onRetry={retry} />
      </OnboardShell>
    )
  }

  // active
  return (
    <AllSet
      classroom={classroom}
      returning={Boolean(returnTo)}
      returnTo={returnTo}
      onContinue={() => returnTo && router.history.push(returnTo)}
    />
  )
}

export default OnboardingPage
