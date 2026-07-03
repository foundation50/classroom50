import {
  CheckCircle2,
  GraduationCap,
  Loader2,
  Mail,
  UserPlus,
} from "lucide-react"
import GitHub from "@/assets/github.svg?react"
import { Spinner } from "@/components/Spinner"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { Link, useParams, useSearch, useRouter } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { useTranslation } from "react-i18next"
import { submitOnboarding } from "@/api/mutations/onboarding"
import { useOnboardingState } from "@/hooks/onboarding/useOnboardingState"
import useGetOwnOrgMembership from "@/hooks/useGetOwnOrgMembership"
import { isValidEmail, isValidInviteToken } from "@/util/onboarding"
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

const NotOrgMember = ({
  org,
  classroom,
}: {
  org?: string
  classroom?: string
}) => {
  const { t } = useTranslation()
  return (
    <div className="min-h-screen bg-base-100">
      <OnboardNavbar />
      <OnboardCard>
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
      </OnboardCard>
    </div>
  )
}

const OnboardingStatus = ({
  classroom,
  title,
  message,
  tone = "success",
  action,
}: {
  classroom?: string
  title: string
  message: string
  tone?: "success" | "info"
  action?: React.ReactNode
}) => {
  const { t } = useTranslation()
  const toneClasses =
    tone === "success"
      ? { box: "border-success/20 bg-success/5", icon: "text-success" }
      : { box: "border-info/20 bg-info/5", icon: "text-info" }
  return (
    <div className="min-h-screen bg-base-100">
      <OnboardNavbar />
      <OnboardCard>
        <EnterDiv className="card-body gap-6">
          <div>
            <span className="badge badge-primary badge-soft gap-2">
              <Mail aria-hidden="true" className="size-4" />
              {t("getStarted.badge")}
            </span>
            <h1 className="mt-6 text-2xl font-bold">{title}</h1>
            {classroom && (
              <p className="mt-2 text-sm text-base-content/70">{classroom}</p>
            )}
          </div>
          <div className={`rounded-2xl border p-5 ${toneClasses.box}`}>
            <div className="flex gap-3">
              <CheckCircle2
                aria-hidden="true"
                className={`size-6 shrink-0 ${toneClasses.icon}`}
              />
              <p className="text-sm text-base-content/70">{message}</p>
            </div>
          </div>
          {action}
        </EnterDiv>
      </OnboardCard>
    </div>
  )
}

const OnboardingPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.getStarted"))
  const { org, classroom } = useParams({ strict: false })
  // Untrusted: only seeds the claimed-email field; the session authorizes.
  const search = useSearch({ strict: false }) as {
    email?: string
    t?: string
    returnTo?: string
  }
  const prefilledEmail = typeof search.email === "string" ? search.email : ""
  // Where to send the student once they've onboarded AND become an active org
  // member (set when the accept page bounced them here). The route already
  // validated it's a same-origin relative path.
  const returnTo =
    typeof search.returnTo === "string" ? search.returnTo : undefined
  // Secure-link token: reconcile's strongest match key. Absent/garbage degrades
  // to the classroom-wide flow (reconcile then matches by github_id, else email).
  const inviteToken =
    typeof search.t === "string" && isValidInviteToken(search.t)
      ? search.t.trim()
      : undefined
  const [email, setEmail] = useState(prefilledEmail)
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  const { user } = useGithubAuth()

  const emailValid = isValidEmail(email)
  const nameValid = firstName.trim().length > 0 && lastName.trim().length > 0
  const formValid = emailValid && nameValid

  const onboardMutation = useMutation({
    mutationFn: () =>
      submitOnboarding(client, {
        org: org ?? "",
        classroom: classroom ?? "",
        email: email.trim(),
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        invite_token: inviteToken,
      }),
    onSuccess: () => {
      // submitOnboarding accepted the pending invite, so the cached membership
      // (shared with the accept page) is stale. Invalidate so both this page's
      // redirect gate and the accept page re-read "active" — else they disagree
      // and the accept page bounces the student back here (loop).
      void queryClient.invalidateQueries({
        queryKey: ["github", "memberships", "orgs", org],
      })
    },
  })
  const runOnboard = useSafeSubmit()

  const state = useOnboardingState({
    org,
    classroom,
    justSubmitted: onboardMutation.isSuccess,
  })

  const router = useRouter()

  // Round-trip: once the student is an active org member, send them back to the
  // accept link. Reads the SAME membership query the accept page uses (freshened
  // above) so the two can't diverge into a loop; wait for "active" before going.
  const { data: orgMembership } = useGetOwnOrgMembership(org)
  const becameActiveMember = orgMembership?.state === "active"

  // Armed once the student has submitted with a returnTo.
  const returningToAssignment = Boolean(returnTo) && onboardMutation.isSuccess

  // Poll membership to flip active: submitOnboarding accepts the invite but
  // GitHub can lag (or the PATCH failed transiently), and the shared query
  // wouldn't otherwise re-read. Bounded, then the pending render shows a manual
  // link so a lag can't strand the student on an endless spinner.
  const MAX_MEMBERSHIP_POLLS = 6
  const [membershipPolls, setMembershipPolls] = useState(0)
  useQuery({
    queryKey: ["github", "onboarding-membership-poll", org, user?.id],
    queryFn: async () => {
      setMembershipPolls((n) => n + 1)
      // Re-read the shared membership query so the gate below (and the accept
      // page) see the fresh value.
      await queryClient.invalidateQueries({
        queryKey: ["github", "memberships", "orgs", org],
      })
      return membershipPolls
    },
    enabled:
      returningToAssignment &&
      !becameActiveMember &&
      membershipPolls < MAX_MEMBERSHIP_POLLS,
    refetchInterval: 1500,
  })
  const pollExhausted =
    returningToAssignment &&
    !becameActiveMember &&
    membershipPolls >= MAX_MEMBERSHIP_POLLS

  // One-shot latch: history.push stacks entries, so fire once when the gate
  // first opens rather than on every re-render.
  const navigatedRef = useRef(false)
  useEffect(() => {
    if (returningToAssignment && becameActiveMember && !navigatedRef.current) {
      navigatedRef.current = true
      // Raw internal path: preserves the accept link's ?k= verbatim; the router
      // applies the basepath.
      router.history.push(returnTo!)
    }
  }, [returningToAssignment, becameActiveMember, returnTo, router])

  if (state === "loading") {
    return (
      <div className="min-h-screen bg-base-100">
        <OnboardNavbar />
        <OnboardCard>
          <Spinner size="xl" label={t("common.loading")} className="m-auto" />
        </OnboardCard>
      </div>
    )
  }

  // No membership record at all: never invited. (A pending invite is not
  // "notInvited" — submitOnboarding self-heals by accepting it first.)
  if (state === "notInvited") {
    return <NotOrgMember org={org} classroom={classroom} />
  }

  // Just-submitted or an existing onboarding repo: awaiting reconcile. When
  // arriving with a returnTo, show a "taking you back" message (the effect above
  // bounces them once membership goes active).
  if (state === "pendingConfirmation") {
    const returning = returningToAssignment
    return (
      <OnboardingStatus
        classroom={classroom}
        tone="info"
        title={
          returning
            ? t("getStarted.pending.enrolledTitle")
            : t("getStarted.pending.title")
        }
        message={
          returning
            ? pollExhausted
              ? t("getStarted.pending.enrolledManual")
              : t("getStarted.pending.takingBack")
            : t("getStarted.pending.message")
        }
        action={
          returning && pollExhausted && returnTo ? (
            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={() => router.history.push(returnTo)}
            >
              {t("getStarted.continueToAssignment")}
            </button>
          ) : undefined
        }
      />
    )
  }

  // Already has classroom access: show "you're all set" instead of the form.
  if (state === "allSet") {
    return (
      <OnboardingStatus
        classroom={classroom}
        tone="success"
        title={t("getStarted.allSet.title")}
        message={t("getStarted.allSet.message")}
      />
    )
  }

  return (
    <div className="min-h-screen bg-base-100">
      <OnboardNavbar />
      <OnboardCard>
        <EnterDiv className="card-body gap-6">
          <div>
            <span className="badge badge-primary badge-soft gap-2">
              <Mail aria-hidden="true" className="size-4" />
              Onboarding
            </span>
            <h1 className="mt-6 text-2xl font-bold">
              {returnTo
                ? t("getStarted.form.titleWithReturn")
                : t("getStarted.form.title")}
            </h1>
            <p className="mt-2 text-base text-base-content/70">
              {t("getStarted.form.subtitle_prefix")}{" "}
              <span className="font-semibold text-base-content">
                {classroom}
              </span>
              {t("getStarted.form.subtitle_suffix")}
            </p>
          </div>

          <div className="flex gap-4 bg-base-200 p-4 rounded-xl border border-base-300">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 text-sm text-base-content/70">
                <GitHub aria-hidden="true" className="size-4" />
                <span>{user?.login ?? t("getStarted.form.checkingUser")}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="onboard-first-name"
                className="text-sm font-medium text-base-content"
              >
                {t("getStarted.form.firstName")}
              </label>
              <input
                id="onboard-first-name"
                type="text"
                value={firstName}
                placeholder={t("getStarted.form.firstNamePlaceholder")}
                className="input w-full mt-2"
                disabled={onboardMutation.isPending}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="onboard-last-name"
                className="text-sm font-medium text-base-content"
              >
                {t("getStarted.form.lastName")}
              </label>
              <input
                id="onboard-last-name"
                type="text"
                value={lastName}
                placeholder={t("getStarted.form.lastNamePlaceholder")}
                className="input w-full mt-2"
                disabled={onboardMutation.isPending}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="onboard-email"
              className="text-sm font-medium text-base-content"
            >
              {t("getStarted.form.email")}
            </label>
            <p className="mt-1 text-xs text-base-content/70">
              {t("getStarted.form.emailHint")}
            </p>
            <div className="mt-2 flex">
              <Mail
                aria-hidden="true"
                className="size-6 mr-2 text-base-content/70"
              />
              <input
                id="onboard-email"
                type="email"
                value={email}
                placeholder={t("getStarted.form.emailPlaceholder")}
                className="input w-full"
                disabled={onboardMutation.isPending}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {email && !emailValid && (
              <p className="text-error text-sm mt-1">
                {t("validation.validEmail")}
              </p>
            )}
          </div>

          {onboardMutation.isError && (
            <div className="alert alert-error alert-soft text-sm">
              {onboardMutation.error instanceof Error
                ? onboardMutation.error.message
                : t("getStarted.form.genericError")}
            </div>
          )}

          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={onboardMutation.isPending || !formValid}
            onClick={() => void runOnboard(() => onboardMutation.mutateAsync())}
          >
            {onboardMutation.isPending ? (
              <>
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                {t("getStarted.form.confirming")}
              </>
            ) : (
              t("getStarted.form.confirm")
            )}
          </button>
        </EnterDiv>
      </OnboardCard>
    </div>
  )
}

export default OnboardingPage
