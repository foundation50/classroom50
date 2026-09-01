import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import {
  AlertIcon,
  CalendarIcon,
  DownloadIcon,
  PeopleIcon,
} from "@/components/ui/icons"
import Papa from "papaparse"

import { useQueryClient } from "@tanstack/react-query"
import {
  useParams,
  useSearch,
  Navigate,
  useNavigate,
} from "@tanstack/react-router"

import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import MissingParams from "@/components/MissingParams"
import {
  Alert,
  Badge,
  Button,
  EmphasisLtr,
  HelpTooltip,
  MetricBar,
  InlineSpinner,
  RouterButton,
} from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import SubmissionsTable from "@/pages/submissions/SubmissionsTable"
import SubmissionsControls from "@/pages/submissions/SubmissionsControls"
import { SubmissionsActionsMenu } from "@/pages/submissions/SubmissionsActionsMenu"
import { AcceptLinkModal } from "@/pages/submissions/AcceptLinkModal"
import { MetricsModal } from "@/pages/submissions/MetricsModal"
import { OpenAllFeedbackPrsModal } from "@/pages/submissions/OpenAllFeedbackPrsModal"
import { DownloadAllSubmissionsModal } from "@/pages/submissions/DownloadAllSubmissionsModal"
import { CloneSubmissionsModal } from "@/pages/submissions/CloneSubmissionsModal"
import { BulkRepoAccessModal } from "@/components/modals/BulkRepoAccessModal"
import { CloseSubmissionModal } from "@/components/modals/CloseSubmissionModal"
import { BulkRepoFeaturesModal } from "@/components/modals/BulkRepoFeaturesModal"
import { BulkRepoVisibilityModal } from "@/components/modals/BulkRepoVisibilityModal"
import { BulkAutogradeStateModal } from "@/components/modals/BulkAutogradeStateModal"
import { BulkSubmissionTriggerModal } from "@/components/modals/BulkSubmissionTriggerModal"
import { isDefaultAutograder } from "@/domain/assignments/autograderYaml"
import { resolveSubmissionMode } from "@/domain/assignments/submissionDetection"
import {
  AssignmentTitleWithSlug,
  AutogradingMeta,
  MetaItem,
  MetaStrip,
  SubmissionModeMeta,
} from "@/components/submissions/SubmissionRowCells"
import {
  assignmentSkipsGrading,
  deriveAutogradingState,
} from "@/domain/assignments/autogradingState"
import { DataFreshness } from "@/pages/submissions/DataFreshness"
import { ConfirmModal } from "@/components/modals"
import {
  DEFAULT_FILTERS,
  DEFAULT_PAGE_SIZE,
  acceptedRosterCount,
  acceptedUsernames,
  applyStatusSelection,
  assignmentRepoNames,
  buildScoresCsvRows,
  buildSectionLookup,
  classAverage,
  computeStats,
  displayPageOwners,
  distinctSections,
  existingGroupRepos,
  existingTeamRepos,
  filterAndSortRows,
  filterNonSubmitters,
  hasAccepted,
  latestAssignmentPush,
  effectiveCollectedAt,
  mergeDetectedSubmissions,
  mergeLiveRows,
  reconcileNonSubmitters,
  pendingMayHide,
  rosterScopedRows,
  rowInSection,
  selectActiveWorkflowAction,
  showsNonSubmitters,
  snapshotIsStale,
  sortNameMode,
  studentInSection,
  submissionRosterStudents,
  type SubmissionFilters,
  type SubmissionSort,
} from "@/pages/submissions/dashboard"
import useGetScores from "@/hooks/useGetScores"
import useLiveSubmissions from "@/hooks/useLiveSubmissions"
import useDetectedSubmissions from "@/hooks/useDetectedSubmissions"
import { useSubmissionAssignment } from "@/hooks/useSubmissionAssignment"
import useGetClassroom from "@/hooks/useGetClassroom"
import useGetStudents from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import { getName, sortStudentsByName } from "@/util/students"
import { studentRepoName, GROUP_REPO_SEGMENT } from "@/util/studentRepo"
import useGroupTeams from "@/hooks/useGroupTeams"
import useGroupTeamMembers from "@/hooks/useGroupTeamMembers"
import type { GroupTeamRef } from "@/domain/teams/groupTeams"
import { downloadBlob } from "@/util/downloadBlob"
import { hasStudentEnrollment } from "@/util/classroomRoleUI"
import type { Student } from "@/types/classroom"
import { isClassroomArchived } from "@/types/classroom"
import { errorText } from "@/types/localizedMessage"
import useEmptyRosterWarning from "@/hooks/useEmptyRosterWarning"
import { EmptyRosterNotice } from "@/components/EmptyRosterNotice"
import useAcceptShareSummary from "@/hooks/useAcceptShareSummary"
import { QueryErrorAlert } from "@/components/QueryErrorAlert"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import { useGroupRepoMemberLogins } from "@/hooks/useGroupRepoMembers"
import useTriggerScoreCollection from "@/hooks/useTriggerScoreCollection"
import useTriggerRegrade from "@/hooks/useTriggerRegrade"
import { useSetAssignmentLock } from "@/hooks/mutations/useSetAssignmentLock"
import { useDeleteAssignment } from "@/hooks/mutations/useDeleteAssignment"
import { useToast } from "@/context/notifications/NotificationProvider"
import { RegradeCoordinatorProvider } from "@/context/regrade/RegradeCoordinator"
import useGetLastCollectScoresRun from "@/hooks/useGetLastCollectScoresRun"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { useIsOrgOwner } from "@/context/githubOrgRole/useIsOrgOwner"
import { can } from "@/authz"
import RoleResolvingFallback from "@/components/RoleResolvingFallback"
import {
  COLLECT_SCORES_WORKFLOW,
  REGRADE_WORKFLOW,
} from "@/github-core/workflows"
import { githubKeys } from "@/github-core/queries"
import { CollectInputsUnsupportedError } from "@/github-core/mutations"
import {
  formatDueDateTime,
  formatRelativeToNow,
  isPastDue,
  dueDeadlineInstant,
} from "@/util/formatDate"
import { githubTemplateRepoUrl } from "@/util/orgUrl"
import { acceptLinkCli, acceptLinkUrl } from "@/util/acceptLink"
import { CONFIG_REPO } from "@/util/configRepo"
import { GitHubLink } from "@/components/GitHubLink"

// Stable empty set for the live non-submitter filter (accepted axis is "all"
// when live, so no accepted-set membership is consulted). Module-level so its
// identity is stable across renders and doesn't churn the memo.
const EMPTY_SET: Set<string> = new Set()

// Stable empty list for the disabled legacy collaborators fan-out (team mode).
const EMPTY_GROUP_REPOS: { owner: string; repoName: string }[] = []

const SubmissionsPageContent = () => {
  const { t } = useTranslation()
  const { org, classroom, assignment } = useParams({ strict: false })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // Regrade-all is a config-repo-write tier action (teacher|hta); Collect and
  // per-row regrade stay all-staff (the page already gates entry on
  // viewClassroomStaffContent). GitHub is the real enforcer; this is the UX gate.
  const { role: classroomRole } = useClassroomRoleContext()
  const canRegradeAll = can("authorAssignments", { classroomRole })
  // Live reads (submit/* releases) hit student repos with the VIEWER's personal
  // token. Only an org owner is admin on every repo and can read them; a TA/HTA
  // is granted per-repo read at collect time but can't enumerate the org, so
  // their live fan-out would 404. So the live overlay is owner-only — non-owners
  // render purely from the collected snapshot. `isOwner` is fail-closed: false
  // until the org role is CONFIRMED owner, so the page shows the snapshot without
  // a live flash while the role resolves.
  const { isOwner } = useIsOrgOwner()
  const {
    data: scoresData,
    refetch: refetchScores,
    isError: scoresError,
    error: scoresErrorObj,
  } = useGetScores(org, classroom)
  // Teacher gradebook is staff-gated by the route, so its assignment metadata
  // comes from the PRIVATE config repo (source:"config"); students never reach
  // this page. `assignments` carries the sibling list for repo-prefix
  // disambiguation below.
  const { assignment: assignmentInfo, assignments: allAssignments } =
    useSubmissionAssignment(org, classroom, assignment, { source: "config" })
  // Team-driven usernames: the classroom GitHub teams are authoritative for
  // enrollment; roster.csv enriches display only. The dashboard consumes
  // Student[], so map enrolled team rows into that shape (see
  // submissionRosterStudents). Every enrolled STUDENT is a gradee (a
  // not-yet-accepted student still lists as "not accepted"); a pure staff
  // member (teacher/TA/HTA, not on the student team) is a gradee only once
  // they've ACCEPTED, matching the collector, which polls the staff teams too
  // but only records a repo that exists.
  const { students: csvStudents } = useGetStudents(org, classroom)
  // Surface the team fetch's error/loading: a transient or permission failure
  // of the enrolled source of truth must render as error+retry, not an
  // authoritative empty roster.
  const {
    rows: teamRows,
    isLoading: rosterLoading,
    isError: rosterError,
    refetch: refetchRoster,
  } = useTeamRoster(org ?? "", classroom ?? "", csvStudents)

  // Assignment shape (group vs individual, empty_repo) and the org repo list
  // are resolved up here because the gradee roster below needs them: a pure
  // staff member (teacher/hta/ta, not on the student team) is shown as a gradee
  // only once they've ACCEPTED — derived from an existing assignment repo — so
  // staff testing the autograde flow appear while staff who never accepted stay
  // hidden. Students are always shown (a not-yet-accepted student still lists as
  // "not accepted"), unchanged.
  const isGroupAssignment = assignmentInfo?.mode === "group"
  // Team mode: a shared repo backed by a per-assignment GitHub Team. Rows are
  // keyed by the `group-<n>` owner segment, members resolve from LIVE team
  // membership, and the legacy collaborator machinery stays untouched.
  const isTeamAssignment = assignmentInfo?.mode === "team"
  // Either shared-repo flavor (legacy group or team): everywhere rows are
  // keyed by a shared repo rather than a student login.
  const isGroupFlavor = isGroupAssignment || isTeamAssignment
  // Whether the assignment entry has been read. Every value derived from it
  // falls back to a default while the query loads and after it fails, so any
  // gate that depends on the real mode or autograder must require this too.
  // `const` is load-bearing: aliased-condition narrowing then narrows
  // assignmentInfo at each gate below, so their property reads need no repeated
  // null check (a `let` makes each one fail with TS18048).
  const assignmentResolved = assignmentInfo != null
  // Assignments that never autograde (empty_repo bare repos, or no_autograder
  // teacher-supplied CI) produce no submit/* releases. Grading UI (Regrade all,
  // per-row regrade, scores, live polling, the trigger retrofit) is hidden and
  // the header's grading badge explains why — including collect/freshness,
  // since a collect scoped to this assignment would be skipped by
  // collect_scores.py anyway. Mirrors the Python skips_grading() predicate
  // family.
  const skipsGrading = assignmentResolved
    ? assignmentSkipsGrading(assignmentInfo)
    : false
  // The narrower bare-repo case: no repos worth managing at all. Only the
  // repo-management bulk actions (access/features) key off this — a
  // no_autograder repo is templated and DOES have repos to manage.
  const isEmptyRepoAssignment = assignmentInfo?.empty_repo === true
  // Locked assignments are closed to students (accept + submission surfaces
  // refuse them); the gradebook stays fully functional for staff, so this is a
  // heads-up banner, not a gate.
  const isLockedAssignment = assignmentInfo?.locked === true
  const isClosedAssignment = assignmentInfo?.closed === true
  // Org repo list drives repo-existence signals (individual acceptance below,
  // group-repo enumeration, the staff-acceptance gate, and the pushed_at
  // staleness heuristic). `refetch` is wired to Collect now + collect-completion so
  // `latestPush` isn't frozen at page load (else a push after load never flips
  // the freshness line to "Out of date").
  const {
    data: orgRepos,
    isLoading: orgReposLoading,
    refetch: refetchOrgRepos,
  } = useGetOrgRepos(org ?? "")
  // Sibling slugs guard group-repo attribution against a slug-extending sibling
  // ("hw1-bonus" under "hw1"); see existingGroupRepos.
  const siblingSlugs = useMemo(
    () => allAssignments.map((a) => a.slug),
    [allAssignments],
  )
  const groupRepoList = useMemo(
    () =>
      isTeamAssignment
        ? existingTeamRepos(orgRepos, classroom ?? "", assignment ?? "")
        : isGroupAssignment
          ? existingGroupRepos(
              orgRepos,
              classroom ?? "",
              assignment ?? "",
              siblingSlugs,
            )
          : [],
    [
      isGroupAssignment,
      isTeamAssignment,
      orgRepos,
      classroom,
      assignment,
      siblingSlugs,
    ],
  )
  // Members of every existing group repo. Legacy group: founders (from the
  // repo name) plus each repo's collaborators. Team mode: LIVE team
  // membership (the authoritative link) — the collaborators fan-out is
  // disabled (empty repo list) so legacy behavior stays byte-identical.
  const { logins: groupCollabLogins, isPending: groupCollabPending } =
    useGroupRepoMemberLogins(
      org ?? "",
      isTeamAssignment ? EMPTY_GROUP_REPOS : groupRepoList,
    )
  const groupTeamsQuery = useGroupTeams(org, classroom, assignment, {
    enabled: isTeamAssignment,
  })
  const groupTeams = groupTeamsQuery.data
  const groupTeamSlugs = useMemo(
    () => (groupTeams ?? []).map((team) => team.slug),
    [groupTeams],
  )
  const {
    membersBySlug: teamMembersBySlug,
    logins: teamMemberLogins,
    isPending: teamMembersPending,
  } = useGroupTeamMembers(org ?? "", groupTeamSlugs)
  const groupRepoMembers = isTeamAssignment
    ? teamMemberLogins
    : groupCollabLogins
  const groupMembersPending = isTeamAssignment
    ? groupTeamsQuery.isLoading || teamMembersPending
    : groupCollabPending
  // Team lookups keyed by the `group-<n>` owner segment (lowercased): live
  // member logins, display names ("Group <n>" when the record has none), and
  // the team slug (recorded on a manual override entry).
  const teamByOwner = useMemo(() => {
    const map = new Map<string, GroupTeamRef>()
    for (const team of groupTeams ?? []) {
      map.set(`${GROUP_REPO_SEGMENT}${team.n}`, team)
    }
    return map
  }, [groupTeams])
  const groupMemberLogins = useMemo(() => {
    if (!isTeamAssignment) return undefined
    const map = new Map<string, string[]>()
    for (const [owner, team] of teamByOwner) {
      const members = teamMembersBySlug.get(team.slug)
      if (members) {
        map.set(
          owner,
          members.map((m) => m.login),
        )
      }
    }
    return map
  }, [isTeamAssignment, teamByOwner, teamMembersBySlug])
  const groupDisplayNames = useMemo(() => {
    if (!isTeamAssignment) return undefined
    const map = new Map<string, string>()
    for (const [owner, team] of teamByOwner) {
      map.set(
        owner,
        team.name || t("submissions.table.teamDefaultName", { n: team.n }),
      )
    }
    return map
  }, [isTeamAssignment, teamByOwner, t])
  const groupRepoFounders = useMemo(
    () =>
      new Set([
        // Team owners are `group-<n>` counters, not logins — members alone
        // carry the identity there.
        ...(isTeamAssignment ? [] : groupRepoList.map((repo) => repo.owner)),
        ...groupRepoMembers,
      ]),
    [isTeamAssignment, groupRepoList, groupRepoMembers],
  )
  // Staff logins who accepted an INDIVIDUAL assignment (their repo exists). Only
  // pure-staff rows need gating; a student row is always included, so scope this
  // to staff-only enrolled rows to keep it cheap. Group acceptance is handled by
  // groupRepoFounders (a founder/member set), so this stays individual-only.
  const acceptedStaffLogins = useMemo(() => {
    const set = new Set<string>()
    if (isGroupFlavor || !orgRepos) return set
    const repoNames = new Set(orgRepos.map((r) => r.name.toLowerCase()))
    for (const row of teamRows) {
      if (row.state !== "enrolled" || hasStudentEnrollment(row)) continue
      const login = row.username.trim()
      if (!login) continue
      if (
        repoNames.has(studentRepoName(classroom ?? "", assignment ?? "", login))
      ) {
        set.add(login.toLowerCase())
      }
    }
    return set
  }, [teamRows, orgRepos, isGroupFlavor, classroom, assignment])
  const [sort, setSort] = useState<SubmissionSort>("name-first")
  // The roster spine's name order follows the user's first/last choice in every
  // mode. `sortNameMode` maps a time sort to first-name order, so a non-name
  // sort is unaffected; the spine, the table display list, and the page-scoped
  // fan-out all stay keyed on the same name mode.
  const rosterSortMode = sortNameMode(sort)
  const students: Student[] = useMemo(
    () =>
      sortStudentsByName(
        submissionRosterStudents(teamRows, {
          acceptedStaffLogins,
          groupRepoMembers: groupRepoFounders,
        }),
        rosterSortMode,
      ),
    [teamRows, acceptedStaffLogins, groupRepoFounders, rosterSortMode],
  )
  // Gate Regrade all / Collect now on an empty roster: dispatching with no
  // students is wasted effort. `show` is loading-aware (won't flash before the
  // roster resolves).
  const emptyRoster = useEmptyRosterWarning(org, classroom)
  // Roster-readiness summary for the share modal (student reach + no-students
  // warning). Owns its own roster reads (React Query dedupes the shared query),
  // like useEmptyRosterWarning.
  const acceptShareSummary = useAcceptShareSummary(org, classroom)
  // Teacher-only page, so reading the classroom's capability-URL secret from
  // classroom.json is fine. For a protected classroom the shared accept link
  // must carry the key as `?k=<secret>`, else students hit "not found".
  const { data: classroomMeta } = useGetClassroom(org, classroom)
  const secret = classroomMeta?.secret
  // An archived classroom refuses config-repo writes, so delete hides.
  const classroomArchived = isClassroomArchived(classroomMeta ?? {})

  const assignmentSubmitUrl = acceptLinkUrl(
    org ?? "",
    classroom ?? "",
    assignment ?? "",
    secret,
  )
  const assignmentSubmitCli = acceptLinkCli(
    org ?? "",
    classroom ?? "",
    assignment ?? "",
    secret,
  )
  // Clones every student repo for this assignment — the git-friendly
  // counterpart of the in-browser zip download (see CloneSubmissionsModal).
  const cloneSubmissionsCli = `gh teacher download ${org} ${classroom} ${assignment}`

  // Toolbar modals: metrics + accept-link are consolidated behind buttons so
  // the roster surfaces near the top instead of below stat cards and the
  // accept disclosure.
  const [metricsOpen, setMetricsOpen] = useState(false)
  const [acceptOpen, setAcceptOpen] = useState(false)
  const [openAllPrsOpen, setOpenAllPrsOpen] = useState(false)
  const [downloadAllOpen, setDownloadAllOpen] = useState(false)
  const [cloneCliOpen, setCloneCliOpen] = useState(false)
  const [bulkAccessOpen, setBulkAccessOpen] = useState(false)
  const [bulkFeaturesOpen, setBulkFeaturesOpen] = useState(false)
  const [bulkVisibilityOpen, setBulkVisibilityOpen] = useState(false)
  const [bulkTriggerOpen, setBulkTriggerOpen] = useState(false)
  const [bulkPauseOpen, setBulkPauseOpen] = useState(false)
  const [bulkResumeOpen, setBulkResumeOpen] = useState(false)
  const [closeSubmissionOpen, setCloseSubmissionOpen] = useState(false)

  // Scope the collector's scores to the CURRENT roster (see rosterScopedRows).
  // Gate on a resolved roster so a transient load/permission failure falls back
  // to unscoped rows rather than blanking a populated gradebook.
  const rosterReady = !rosterLoading && !rosterError
  const snapshotRows = useMemo(() => {
    return scoresData?.submissions?.[assignment ?? ""] || []
  }, [scoresData, assignment])

  // Dashboard controls — all client-side over already-loaded data. Declared
  // early because the live fan-out below is coupled to the current table page:
  // it reads only the repos on the page you're viewing (see livePageOwners), so
  // the page/size/filters must be known before it runs.
  const [query, setQuery] = useState("")
  // ?status= deep-links a pre-filtered cohort (e.g. the assignments table's
  // Accepted cell links here with "not-accepted"). Applied as the filter
  // state's initial value, then re-applied if the param changes in place
  // (cohort link while already mounted) — render-purely, like the page reset
  // below, so no setState-in-effect.
  const { status: statusParam } = useSearch({ strict: false })
  const [filters, setFilters] = useState<SubmissionFilters>(() =>
    statusParam
      ? applyStatusSelection(DEFAULT_FILTERS, statusParam)
      : DEFAULT_FILTERS,
  )
  const [lastStatusParam, setLastStatusParam] = useState(statusParam)
  if (statusParam !== lastStatusParam) {
    setLastStatusParam(statusParam)
    if (statusParam) {
      setFilters((current) => applyStatusSelection(current, statusParam))
    }
  }
  // Client-side table pagination over the display list, held in the URL
  // (Primer: pagination is URL state — reload/back keep the page and a view
  // is sharable). 1-based `?page=` in the URL, 0-based internally; page 1 and
  // the default size never travel. Clamped at render (pageBounds) so a
  // filter that shrinks the list can't strand the view on an empty page.
  const { page: pageParam, pageSize: pageSizeParam } = useSearch({
    strict: false,
  })
  const page = (pageParam ?? 1) - 1
  const pageSize = pageSizeParam ?? DEFAULT_PAGE_SIZE
  const setPage = useCallback(
    (next: number) => {
      void navigate({
        to: ".",
        // Paging is a navigation step: pushed, so Back walks pages.
        search: (prev) => ({
          ...prev,
          page: next >= 1 ? next + 1 : undefined,
        }),
        resetScroll: false,
      })
    },
    [navigate],
  )
  const setPageSize = useCallback(
    (next: number) => {
      void navigate({
        to: ".",
        search: (prev) => ({
          ...prev,
          pageSize: next === DEFAULT_PAGE_SIZE ? undefined : next,
          page: undefined,
        }),
        resetScroll: false,
      })
    },
    [navigate],
  )
  // Reset to the first page whenever the visible set changes (new search,
  // filter, sort, or a different assignment). The URL page param is cleared
  // via a replace so the reset doesn't pollute history; the render-time
  // clamp covers the frame until the navigation lands.
  const viewSignature = `${query}|${JSON.stringify(filters)}|${sort}|${pageSize}|${assignment ?? ""}`
  const lastViewSignatureRef = useRef(viewSignature)
  useEffect(() => {
    if (viewSignature === lastViewSignatureRef.current) return
    lastViewSignatureRef.current = viewSignature
    if (pageParam !== undefined) {
      void navigate({
        to: ".",
        search: (prev) => ({
          ...prev,
          page: undefined,
        }),
        replace: true,
        resetScroll: false,
      })
    }
  }, [viewSignature, pageParam, navigate])
  // The animation signature drops the search text: re-keying the rows on every
  // keystroke would remount and replay the whole tbody entrance while typing.
  // Filter/sort/size/assignment changes still re-stagger.
  const animationSignature = `${JSON.stringify(filters)}|${sort}|${pageSize}|${assignment ?? ""}`

  // Section filtering: distinct sections for the dropdown, plus a username ->
  // section lookup so submitted rows (which carry only logins) can be matched.
  // Defined early because the page-scoped live fan-out below filters its owner
  // slice by section.
  const sections = useMemo(() => distinctSections(students), [students])
  const sectionByUsername = useMemo(
    () => buildSectionLookup(students),
    [students],
  )

  // Due-date presentation: absolute date + a relative countdown ("in 3 days" /
  // "2 hours ago"). Past due flips the badge to error and the label to overdue.
  const dueDate = assignmentInfo?.due
  const dueOverdue = dueDate ? isPastDue(dueDate) : false
  const dueRelative = dueDate
    ? formatRelativeToNow(dueDeadlineInstant(dueDate) ?? new Date(dueDate))
    : null

  // Whether the live presence overlay applies here: owner-only (personal token
  // can read the repos) and an assignment that autogrades (empty_repo and
  // no_autograder never produce submit/* releases). A non-owner renders purely
  // from the collected snapshot.
  const liveCapable = isOwner && !skipsGrading

  // Detection is a SEPARATE capability from live presence, and deliberately
  // wider: it reads raw repo state (commits/tags), so it works for a
  // no_autograder assignment, which produces no submit/* release and which
  // collect_scores.py skips outright — leaving scores.json permanently empty
  // (issue #659). Only a bare empty_repo is excluded: it carries no submission
  // definition to detect against.
  const detectionCapable = isOwner && !isEmptyRepoAssignment

  // Either overlay makes the view more than a replay of the collected snapshot,
  // so the affordances that describe "we're still resolving rows beyond the
  // snapshot" key off this union rather than live alone.
  const overlayCapable = liveCapable || detectionCapable

  // Live submission presence for THIS assignment comes from student repos'
  // submit/* releases, so a student who pushed but hasn't been collected yet
  // still shows as submitted (issue #347). The fan-out spine is always built
  // from the SNAPSHOT display list (never the live-merged rows), so honoring the
  // real sort/filters can't loop the fan-out's output back into its input.
  // PAGE-SCOPED: it reads only the repos on the CURRENT table page (#359's burst
  // mitigation). Owner-only, off for empty_repo.
  const snapshotScoped = useMemo(
    () =>
      rosterReady ? rosterScopedRows(snapshotRows, students) : snapshotRows,
    [rosterReady, snapshotRows, students],
  )
  // Non-submitter pool for the fan-out's display list, filtered by the SAME
  // query + section + submission axes the rendered table applies — so the
  // fanned page lines up with the visible page. The ACCEPTED axis is neutralized
  // here: this pool is deliberately snapshot-independent (empty accepted set) so
  // it can't loop on live results, and `filterNonSubmitters` would otherwise
  // test acceptance against that empty set and wrongly drop every owner. The
  // rendered non-submitter list (visibleNonSubmitters) applies the real
  // acceptedSet.
  const liveNonSubmitterPool = useMemo(
    () =>
      filterNonSubmitters(
        students,
        query,
        { ...filters, accepted: "all" },
        EMPTY_SET,
      ),
    [students, query, filters],
  )
  const liveOwnerArgs = useMemo(
    () => ({
      isGroup: isGroupFlavor,
      sort,
      students,
      rows: filterAndSortRows(snapshotScoped, {
        query,
        filters,
        sort,
        students,
        sectionByUsername,
        thresholdFraction: null,
      }),
      nonSubmitters: liveNonSubmitterPool,
      groupRepos: groupRepoList,
    }),
    [
      isGroupFlavor,
      sort,
      students,
      snapshotScoped,
      query,
      filters,
      sectionByUsername,
      groupRepoList,
      liveNonSubmitterPool,
    ],
  )
  const livePageOwners = useMemo(
    () => displayPageOwners({ ...liveOwnerArgs, page, pageSize }),
    [liveOwnerArgs, page, pageSize],
  )
  const {
    submissions: liveSubmissions,
    errorCount: liveErrorCount,
    isPending: livePending,
    refetch: refetchLive,
  } = useLiveSubmissions({
    org,
    classroom,
    assignment,
    repoOwners: livePageOwners,
    // Owner-only, not empty_repo — see liveCapable.
    enabled: liveCapable,
  })

  // Detection overlay (submission-configuration hybrid model): the same
  // page-scoped owners as the live fan-out, reading each repo's default-branch
  // pushes (branch mode) or git tags (tag mode) so a submission shows even
  // without a submit/* release. Grades still come from the snapshot/live side.
  const {
    detected: detectedSubmissions,
    isPending: detectedPending,
    refetch: refetchDetected,
  } = useDetectedSubmissions({
    org,
    classroom,
    assignment,
    mode: assignmentInfo?.submission_mode,
    submissionTags: assignmentInfo?.submission_tags,
    repoOwners: livePageOwners,
    // Owner-only and detection-capable (no_autograder included) — see
    // detectionCapable. Resolved-only: otherwise the fan-out starts with an
    // undefined mode and counts a tag-mode assignment in branch mode.
    enabled: detectionCapable && assignmentResolved,
  })

  // Overlay live presence over the snapshot for a live-capable viewer (snapshot
  // wins per owner for GRADES; live adds a pending row for an as-yet-uncollected
  // submitter and bumps stale counts), then overlay detection the same way (a
  // second count/presence-only overlay on the same snapshot — KTD6). A viewer
  // with NEITHER overlay (TA/HTA) uses the collected snapshot ALONE. The two
  // overlays are independent: a no_autograder assignment is detection-capable
  // but not live-capable, and detection alone is what makes its submissions
  // visible at all (issue #659). Then roster-scope, gated on a resolved roster
  // so a transient failure falls back to unscoped rows rather than blanking a
  // populated gradebook.
  const scoresInfo = useMemo(() => {
    if (!overlayCapable) {
      return rosterReady
        ? rosterScopedRows(snapshotRows, students)
        : snapshotRows
    }
    const withLive = liveCapable
      ? mergeLiveRows(
          snapshotRows,
          liveSubmissions.map((s) => ({
            owner: s.owner,
            datetime: s.submittedAt,
            release: s.releaseUrl,
            submissionCount: s.submissionCount,
          })),
          assignmentInfo?.due,
        )
      : snapshotRows
    const merged = detectionCapable
      ? mergeDetectedSubmissions(
          withLive,
          detectedSubmissions.map((d) => ({
            owner: d.owner,
            count: d.count,
            entries: d.entries,
          })),
          assignmentInfo?.due,
        )
      : withLive
    return rosterReady ? rosterScopedRows(merged, students) : merged
  }, [
    overlayCapable,
    liveCapable,
    detectionCapable,
    snapshotRows,
    liveSubmissions,
    detectedSubmissions,
    rosterReady,
    students,
    assignmentInfo?.due,
  ])

  // Repos whose latest submission landed after the deadline. `late` is computed
  // upstream (collect_scores.py) from push time, not grade time.
  const lateCount = scoresInfo.filter((row) => row.late).length

  // Roster students with no submission. "Credited" = login appears in any row's
  // `usernames` (member_usernames for groups, else [owner]), so group teammates
  // aren't falsely flagged. For groups, uncredited students surface as
  // "No group · not submitted" (see #174) — a student who never joined a
  // submitting group has no repo, so the row makes the omission explicit
  // instead of vanishing. A member of an existing group repo (its founder, or
  // any cached collaborator) is excluded here — they already appear as that
  // group's row (#245), so listing them as "no group" too would double-count
  // them. Gated on scores having loaded — until then scoresInfo is empty and
  // would flag the whole roster.
  // Hold the "not submitted" list until every source that can still reclassify
  // a student settles (snapshot, live presence, detection, group-member
  // reconciliation) — else a submitter flashes "not submitted" before its row
  // resolves. detectedPending matters on its own for a no_autograder
  // assignment, where detection is the ONLY thing that can credit a submitter.
  const scoresLoaded = scoresData !== undefined
  // Empty rows before the snapshot+roster land mean "loading", not "empty" —
  // gate the empty state on this so it doesn't flash on first paint. A
  // background refetch keeps scoresLoaded true, so Refresh never blanks the table.
  // Group mode additionally waits for the org repo list: its rows (and the
  // "No groups yet" empty state) are derived from repo existence, so painting
  // before the list resolves would flash a wrong affirmative claim.
  const initialLoading =
    !scoresLoaded || rosterLoading || (isGroupFlavor && orgReposLoading)
  const nonSubmittersReady =
    scoresLoaded && !livePending && !detectedPending && !groupMembersPending
  const nonSubmitters = useMemo(() => {
    if (!nonSubmittersReady) return []
    return reconcileNonSubmitters(students, scoresInfo, groupRepoFounders)
  }, [nonSubmittersReady, scoresInfo, students, groupRepoFounders])

  // Dashboard controls — all client-side over already-loaded data.
  // Drives the "Regrade all" confirmation modal (replaces window.confirm).
  const [regradeConfirmOpen, setRegradeConfirmOpen] = useState(false)
  // Drives the lock/unlock confirmation modal (opened from the actions menu).
  const [lockConfirmOpen, setLockConfirmOpen] = useState(false)
  // Drives the delete-assignment confirmation modal (also menu-opened).
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

  // Whether a search/filter is narrowing the set — drives the table's
  // "filters hide everything" vs "nothing collected yet" empty state, and its
  // Clear-filters escape hatch.
  const hasActiveFilter =
    query.trim() !== "" ||
    filters.submission !== "all" ||
    filters.passing !== "all" ||
    filters.accepted !== "all" ||
    filters.section !== "all"
  const clearFilters = () => {
    setQuery("")
    setFilters({ ...DEFAULT_FILTERS })
  }

  // Honest note for a viewer whose sort/filter can hide a not-yet-collected
  // overlay row (live-only or detection-only) from the page-scoped fan-out (a
  // time sort, or a grade-implying status/passing filter). We keep every control
  // live and surface this instead of hiding Sort + Status.
  const showPendingHiddenHint = pendingMayHide(overlayCapable, sort, filters)

  // Deterministic acceptance from the org repo list (see acceptedUsernames);
  // individual assignments only, so gated on acceptedAvailable.
  const acceptedSet = useMemo(
    () =>
      acceptedUsernames(orgRepos, classroom ?? "", assignment ?? "", students),
    [orgRepos, classroom, assignment, students],
  )
  const acceptedAvailable = !isGroupFlavor && orgRepos != null

  // Every existing assignment repo name (individual + group), for the bulk
  // "Open all Feedback PRs" action. Derived from the already-loaded org repo
  // list, so no extra reads. Only meaningful for a live-capable owner on a
  // non-empty_repo assignment (the action is hidden otherwise).
  const allAssignmentRepos = useMemo(
    () =>
      assignmentRepoNames({
        isGroup: isGroupAssignment,
        isTeam: isTeamAssignment,
        repos: orgRepos,
        classroom: classroom ?? "",
        assignment: assignment ?? "",
        students,
        siblingSlugs,
      }),
    [
      isGroupAssignment,
      isTeamAssignment,
      orgRepos,
      classroom,
      assignment,
      students,
      siblingSlugs,
    ],
  )

  // This assignment's currently-PUBLIC repos (lowercased), for the table's
  // per-row warning badge — derived from the already-loaded org repo list, no
  // extra reads. undefined while that list loads, so the table renders no
  // badges rather than asserting "all private".
  const publicRepoNames = useMemo(() => {
    if (!orgRepos) return undefined
    const assignmentRepos = new Set(
      allAssignmentRepos.map((name) => name.toLowerCase()),
    )
    const set = new Set<string>()
    for (const repo of orgRepos) {
      const name = repo.name.toLowerCase()
      if (repo.private === false && assignmentRepos.has(name)) {
        set.add(name)
      }
    }
    return set
  }, [orgRepos, allAssignmentRepos])

  // Group repos that exist but have no submission yet: for group assignments the
  // repo is named after the founder (not each member), so acceptance can't be
  // derived per student — instead surface every group repo from the org list
  // (#245) so teachers can see teams that formed before anyone pushes. Submitted
  // groups already show as score rows, so drop them here.
  const submittedGroupOwners = useMemo(
    () => new Set(scoresInfo.map((row) => row.owner.toLowerCase())),
    [scoresInfo],
  )
  const unsubmittedGroupRepos = useMemo(
    () => groupRepoList.filter((repo) => !submittedGroupOwners.has(repo.owner)),
    [groupRepoList, submittedGroupOwners],
  )

  // With a section filter active, scope roster and rows to it so the stat cards
  // describe the filtered view, not the whole class.
  const sectionFilter = filters.section
  const scopedStudents = useMemo(
    () =>
      sectionFilter === "all"
        ? students
        : students.filter((s) => studentInSection(s, sectionFilter)),
    [students, sectionFilter],
  )
  const scopedScores = useMemo(
    () =>
      sectionFilter === "all"
        ? scoresInfo
        : scoresInfo.filter((row) =>
            rowInSection(row, sectionFilter, sectionByUsername),
          ),
    [scoresInfo, sectionFilter, sectionByUsername],
  )

  // Owners (student login or group founder) that actually pushed a submission —
  // the set the bulk download fetches. Derived from the section-scoped rows so
  // "Download all" matches the filtered view the teacher sees; never-accepted /
  // accepted-no-push students are already excluded (they have no score row).
  const downloadableOwners = useMemo(
    () => scopedScores.map((row) => row.owner),
    [scopedScores],
  )
  const acceptedOwners = useMemo(() => [...acceptedSet], [acceptedSet])
  const scopedNonSubmitters = useMemo(
    () =>
      sectionFilter === "all"
        ? nonSubmitters
        : nonSubmitters.filter((s) => studentInSection(s, sectionFilter)),
    [nonSubmitters, sectionFilter],
  )

  // Passing bar as a fraction of max, or null when the teacher didn't opt in
  // (off by default) — then no Passing rollup/filter, neutral badges.
  const passThresholdPct = assignmentInfo?.pass_threshold
  const passingEnabled =
    typeof passThresholdPct === "number" && Number.isFinite(passThresholdPct)
  const thresholdFraction = passingEnabled ? passThresholdPct / 100 : null

  // Top-line counts over the (section-scoped) submitted set + roster size.
  const stats = useMemo(
    () => computeStats(scopedScores, scopedStudents.length, thresholdFraction),
    [scopedScores, scopedStudents, thresholdFraction],
  )

  // Class average over numeric scores in the section-scoped set; null -> "N/A".
  const avgScore = useMemo(() => classAverage(scopedScores), [scopedScores])

  // Accepted count scoped to the active section (matches the card's denominator).
  const acceptedCount = useMemo(
    () => acceptedRosterCount(scopedStudents, acceptedSet),
    [scopedStudents, acceptedSet],
  )

  // The header funnel's Submitted numerator: PRESENCE, not grades. Unlike
  // stats.submitted (which excludes `pending` rows so uncollected submissions
  // don't inflate the graded Metrics summary), the bar must agree with the
  // table right below it — which lists pending live/detected submitters
  // (the only signal for no_autograder assignments). Count every scoped row.
  const submittedPresenceCount = scopedScores.length

  // The header bar's submission share: over the student-role roster for
  // individual assignments, over existing group repos for group ones. Clamped
  // (KTD4-style) so a staff/extra repo can't push the share past 100%.
  const funnelTotal = stats.rostered
  const submittedShare = Math.min(submittedPresenceCount, funnelTotal)
  const submittedGroups = groupRepoList.length - unsubmittedGroupRepos.length
  // Show the bar once its denominator is real: repo list resolved, and (for
  // groups) at least one group repo exists.
  const showSubmissionProgress = isGroupFlavor
    ? orgRepos != null && groupRepoList.length > 0
    : acceptedAvailable

  // Roster students who accepted (repo exists) but have no submission row.
  // Individual assignments only.
  const acceptedNotSubmittedCount = acceptedAvailable
    ? scopedNonSubmitters.filter((s) => hasAccepted(s.username, acceptedSet))
        .length
    : 0

  // One-click stat shortcuts: jump to the students a sub-label calls out. Reset
  // the other axes so the surfaced set matches the label exactly.
  const showFailing = () =>
    setFilters({ ...DEFAULT_FILTERS, passing: "failing" })
  // On this page a "not submitted" row implies the student accepted (no repo
  // ⇒ nothing to submit), so the accepted-not-submitted set is just the
  // not-submitted filter — a single axis the Status select represents exactly,
  // so switching away from it never silently drops a hidden acceptance filter.
  const showAcceptedNotSubmitted = () =>
    setFilters({ ...DEFAULT_FILTERS, submission: "not-submitted" })

  // Rows actually rendered. When acceptance data isn't loaded, neutralize the
  // accepted axis so a transient empty repo list can't flip the visible set.
  // This acceptance neutralization is independent of live mode — the sort and
  // status/passing axes always reflect the user's real selection.
  const effectiveFilters = useMemo(
    () =>
      acceptedAvailable ? filters : { ...filters, accepted: "all" as const },
    [acceptedAvailable, filters],
  )
  const visibleRows = useMemo(
    () =>
      filterAndSortRows(scoresInfo, {
        query,
        filters: effectiveFilters,
        sort,
        students,
        sectionByUsername,
        thresholdFraction,
      }),
    [
      scoresInfo,
      query,
      effectiveFilters,
      sort,
      students,
      sectionByUsername,
      thresholdFraction,
    ],
  )
  const visibleNonSubmitters = useMemo(
    () =>
      showsNonSubmitters(effectiveFilters)
        ? filterNonSubmitters(
            nonSubmitters,
            query,
            effectiveFilters,
            acceptedSet,
          )
        : [],
    [effectiveFilters, nonSubmitters, query, acceptedSet],
  )

  // Group repos without a submission, gated like non-submitters (hidden while a
  // narrowing filter other than "not submitted" is active) and matched against
  // the search by founder login or roster name. Section isn't filtered — a group
  // repo carries no single section.
  const visibleGroupRepos = useMemo(() => {
    if (!showsNonSubmitters(effectiveFilters)) return []
    const q = query.trim().toLowerCase()
    if (!q) return unsubmittedGroupRepos
    return unsubmittedGroupRepos.filter((repo) => {
      if (repo.owner.includes(q)) return true
      const name = getName(repo.owner, students).toLowerCase()
      return name.length > 0 && name.includes(q)
    })
  }, [effectiveFilters, query, unsubmittedGroupRepos, students])

  // Scope the manual collect to this assignment: the workflow serializes runs
  // per scope and the Python side collects only the matching slug, so "Collect
  // now" here doesn't rebuild every classroom's gradebook.
  const collectScores = useTriggerScoreCollection(
    org,
    classroom && assignment ? { classroom, assignment } : undefined,
  )
  const regradeAll = useTriggerRegrade({ org, classroom, assignment })
  const { notify, announce } = useToast()
  // Lock/unlock this assignment. The page owns the mutation (like Regrade all)
  // and surfaces the non-fatal template-access warning; the menu just triggers
  // the confirm. Gated on authoring rights at the call site.
  const setLock = useSetAssignmentLock(org ?? "", classroom ?? "", (result) => {
    if (result.templateAccessWarning) {
      // Kept as a toast: a non-fatal partial outcome with no page anchor.
      notify({ tone: "warning", message: result.templateAccessWarning })
      return
    }
    // The locked/closed banner and header badge flip in place — SR
    // announcement only (Primer: success messaging sparingly).
    announce(
      result.locked
        ? t("submissions.lock.lockSuccess")
        : t("submissions.lock.unlockSuccess"),
    )
  })
  // Same delete mechanism as the assignments table's manage hub (removes the
  // assignments.json entry; student repos are kept).
  const deleteAssignmentMutation = useDeleteAssignment()
  // `anyRegrading` covers the whole-assignment regrade AND every per-row
  // regrade (via the page coordinator), so collect/regrade controls disable
  // while any regrade is in flight.
  const regrading = regradeAll.anyRegrading
  // Whether "Regrade all" specifically is mid-dispatch, for its own
  // spinner/label (distinct from the page-wide `regrading` gate).
  const regradeAllActive =
    regradeAll.phase === "dispatching" || regradeAll.phase === "running"
  const { data: lastRun } = useGetLastCollectScoresRun(org)
  const collectWorkflowUrl = `https://github.com/${org}/${CONFIG_REPO}/actions/workflows/${COLLECT_SCORES_WORKFLOW}`
  const regradeWorkflowUrl = `https://github.com/${org}/${CONFIG_REPO}/actions/workflows/${REGRADE_WORKFLOW}`
  const collecting =
    collectScores.phase === "dispatching" || collectScores.phase === "running"

  // Which action the single "View …" link points at and which status strip (if
  // any) shows. Running takes precedence; else most recently finished; else
  // null. Derived fresh every render so the link never gets stuck on a stale
  // action.
  const activeAction = selectActiveWorkflowAction(
    { running: collecting, idle: collectScores.phase === "idle" },
    { running: regrading, idle: regradeAll.phase === "idle" },
  )

  const isRegradeView = activeAction === "regrade"
  const viewRun = isRegradeView ? regradeAll.run : collectScores.run
  const viewWorkflowUrl = isRegradeView
    ? regradeWorkflowUrl
    : collectWorkflowUrl
  const viewLabel = isRegradeView
    ? viewRun
      ? t("submissions.actions.viewRegradeRun")
      : t("submissions.actions.viewRegradeWorkflow")
    : viewRun
      ? t("submissions.actions.viewRun")
      : t("submissions.actions.viewWorkflow")

  // Staleness heuristic (no extra API call): the most recent push across this
  // assignment's repos, read from the already-loaded org repo list's pushed_at.
  // If it's newer than the last completed collect run, scores.json probably
  // misses the newest work, so DataFreshness flags it and offers a re-collect.
  const latestPush = useMemo(
    () =>
      latestAssignmentPush(
        orgRepos,
        classroom ?? "",
        assignment ?? "",
        siblingSlugs,
      ),
    [orgRepos, classroom, assignment, siblingSlugs],
  )

  // Gating trackedCompletedAt on phase "completed" means conclusion ===
  // "success" (see useGitHubOperation), so a failed/timed-out run never
  // relaxes the button. Both the freshness label and the staleness badge read
  // the one effectiveCollectedAt value so they can't disagree; that helper
  // owns the bucket-stamp vs run-timestamp precedence.
  const lastRunCompletedAt =
    lastRun?.status === "completed" ? lastRun.created_at : null
  const trackedCompletedAt =
    collectScores.phase === "completed"
      ? (collectScores.run?.created_at ?? null)
      : null
  const effectiveLastCollectedAt = effectiveCollectedAt({
    bucketCollectedAt: scoresData?.collectedAt?.[assignment ?? ""] ?? null,
    collectorStampsBuckets:
      Object.keys(scoresData?.collectedAt ?? {}).length > 0,
    lastRunCompletedAt,
    trackedCompletedAt,
  })

  const lastCollectedLabel = effectiveLastCollectedAt
    ? formatRelativeToNow(new Date(effectiveLastCollectedAt))
    : null
  // Staleness applies wherever a collect exists. A no_autograder assignment is
  // collected (detected submissions), so a push after the last run means its
  // snapshot is out of date too; only a bare empty_repo has nothing to collect.
  const snapshotStale =
    !isEmptyRepoAssignment &&
    snapshotIsStale(latestPush, effectiveLastCollectedAt)

  // Refresh scores + last-run timestamp + org repo list once a manual collection
  // finishes, so the freshness line re-derives (the collect just consumed the
  // pushes latestPush was flagging). Invalidate the last-run query rather than
  // refetching it: its 60s staleTime would otherwise let a cached entry from
  // before the run short-circuit the update, leaving the "Last collected" line
  // lagging even though the button color is already correct from the tracked run.
  useEffect(() => {
    if (collectScores.phase === "completed") {
      refetchScores()
      if (org) {
        queryClient.invalidateQueries({
          queryKey: githubKeys.lastCollectScoresRun(org),
        })
      }
      refetchOrgRepos()
    }
  }, [collectScores.phase, org, queryClient, refetchScores, refetchOrgRepos])

  const downloadScoresCsv = () => {
    // Group grades are per-repo (keyed by the founder/owner), so a per-teammate
    // "score 0" row is meaningless — and worse, on a degraded collect that
    // credited only the owner, a submitting teammate would be exported as 0,
    // clobbering their real group grade. So the CSV covers group non-submitters
    // via their group's row, not as individual score-0 rows (restoring the
    // pre-#174 export). Individual non-submitters (accepted-no-push or
    // never-accepted) are still legitimately 0 and stay in the export.
    const csvNonSubmitters = isGroupFlavor ? [] : nonSubmitters
    // Export the authoritative snapshot, not the live-merged view: `scoresInfo`
    // carries live count bumps only for the current page's owners, which would
    // make the file's counts depend on the last-viewed page. `snapshotScoped`
    // (the roster-scoped snapshot, already memoized for the fan-out spine) always
    // matches scores.json regardless of paging.
    const rows = buildScoresCsvRows(
      snapshotScoped,
      csvNonSubmitters,
      students,
      sort,
    )

    const csv = Papa.unparse(rows, {
      header: true,
    })

    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8;",
    })

    downloadBlob(blob, `${classroom}-${assignment}-scores.csv`)
  }

  if (!org || !classroom || !assignment) {
    return <MissingParams message={t("submissions.missingParams")} />
  }

  return (
    <PageShell>
      <Breadcrumb switcher="assignment" assignmentName={assignmentInfo?.name} />
      {emptyRoster.show && (
        <EmptyRosterNotice
          org={org}
          classroom={classroom}
          hasRosterRows={emptyRoster.hasRosterRows}
        />
      )}
      {rosterError && (
        <QueryErrorAlert
          message={
            <>
              {t("submissions.errors.rosterLoad")}{" "}
              {t("submissions.errors.rosterLoadHint")}
            </>
          }
          onRetry={() => refetchRoster()}
        />
      )}
      {scoresError && (
        <QueryErrorAlert
          message={
            <>
              {scoresErrorObj instanceof Error
                ? t("submissions.errors.gradebookLoadWithReason", {
                    reason: errorText(t, scoresErrorObj),
                  })
                : t("submissions.errors.gradebookLoad")}{" "}
              {t("submissions.errors.gradebookLoadHint")}
            </>
          }
          onRetry={() => refetchScores()}
        />
      )}
      <PageHeader
        title={
          assignmentInfo && (
            <AssignmentTitleWithSlug
              name={assignmentInfo.name}
              slug={assignmentInfo.slug}
            />
          )
        }
        subtitle={
          // Property items are quiet meta text; only genuine states (overdue,
          // approaching deadline, late, closed) keep toned badges. The
          // submission-progress bar leads the strip — the page's headline
          // number — and doubles as a one-click jump to who hasn't submitted.
          <MetaStrip
            items={[
              showSubmissionProgress && (
                <button
                  type="button"
                  onClick={showAcceptedNotSubmitted}
                  title={t("submissions.funnel.showNotSubmitted")}
                  className="-m-1 cursor-pointer rounded-btn p-1 hover:bg-base-200"
                >
                  <MetricBar
                    value={isGroupFlavor ? submittedGroups : submittedShare}
                    max={isGroupFlavor ? groupRepoList.length : funnelTotal}
                    tone="success"
                    showNumbers={false}
                    title={
                      isGroupFlavor
                        ? t("submissions.funnel.submittedTitleGroup", {
                            submitted: submittedGroups,
                            accepted: groupRepoList.length,
                          })
                        : t("submissions.funnel.submittedTitle", {
                            submitted: submittedShare,
                            total: funnelTotal,
                          })
                    }
                  />
                </button>
              ),
              dueDate ? (
                <span className="inline-flex items-center gap-2">
                  {dueOverdue ? (
                    <Badge
                      tone="error"
                      size="md"
                      title={formatDueDateTime(dueDate)}
                    >
                      {t("submissions.dueDate", {
                        date: formatDueDateTime(dueDate),
                      })}
                    </Badge>
                  ) : (
                    <MetaItem title={formatDueDateTime(dueDate)}>
                      <CalendarIcon aria-hidden="true" className="size-4" />
                      {t("submissions.dueDate", {
                        date: formatDueDateTime(dueDate),
                      })}
                    </MetaItem>
                  )}
                  {dueRelative && (
                    <Badge tone={dueOverdue ? "error" : "warning"} size="md">
                      {dueRelative}
                    </Badge>
                  )}
                </span>
              ) : (
                <span className="text-base-content/60">
                  {t("submissions.noDueDate")}
                </span>
              ),
              lateCount > 0 && (
                <Badge tone="error" size="sm">
                  {t("submissions.lateBadge", { count: lateCount })}
                </Badge>
              ),
              isClosedAssignment && (
                <Badge tone="warning" size="md">
                  {t("submissions.closeSubmission.statusBadge.closed")}
                </Badge>
              ),
              assignmentResolved && (
                <SubmissionModeMeta mode={assignmentInfo.submission_mode} />
              ),
              assignmentResolved && (
                <AutogradingMeta
                  state={deriveAutogradingState(assignmentInfo)}
                />
              ),
              assignmentInfo?.template && (
                <GitHubLink
                  href={githubTemplateRepoUrl(
                    assignmentInfo.template.owner,
                    assignmentInfo.template.repo,
                    assignmentInfo.template.branch,
                  )}
                  label={t("submissions.viewSourceRepo")}
                  title={`${assignmentInfo.template.owner}/${assignmentInfo.template.repo}`}
                />
              ),
            ]}
          />
        }
      />

      {isLockedAssignment && (
        <Alert tone="info" role="status">
          {t("submissions.lockedNotice")}
        </Alert>
      )}

      {isClosedAssignment && !isLockedAssignment && (
        <Alert tone="info" role="status">
          {t("submissions.closedNotice")}
        </Alert>
      )}

      {/* Live status strip. Full phase mapping: dispatching stays a quiet
          neutral line (transient); running/completed/failed/timeout become an
          Alert; idle renders nothing. */}
      {activeAction === "collect" && collectScores.phase !== "idle" && (
        <>
          {collectScores.phase === "dispatching" && (
            <p className="text-sm text-base-content/70" role="status">
              {t("submissions.collect.statusDispatching")}
            </p>
          )}
          {collectScores.phase === "running" && (
            <Alert tone="info" role="status">
              <InlineSpinner />
              {t("submissions.collect.statusRunning")}
            </Alert>
          )}
          {collectScores.phase === "completed" && (
            <Alert tone="success" role="status">
              {t("submissions.collect.statusCompleted")}
            </Alert>
          )}
          {collectScores.phase === "failed" && (
            <Alert tone="error" role="status">
              {collectScores.error instanceof CollectInputsUnsupportedError ? (
                t("submissions.collect.workflowOutdated")
              ) : (
                <>
                  {collectScores.error instanceof Error
                    ? t("submissions.collect.statusFailedWithReason", {
                        reason: errorText(t, collectScores.error),
                      })
                    : t("submissions.collect.statusFailed")}{" "}
                  {t("submissions.collect.statusFailedHint")}
                </>
              )}
            </Alert>
          )}
          {collectScores.phase === "timeout" && (
            <Alert tone="warning" role="status">
              {t("submissions.collect.statusTimeout")}
            </Alert>
          )}
        </>
      )}
      {activeAction === "regrade" && regradeAll.phase !== "idle" && (
        <>
          {regradeAll.phase === "dispatching" && (
            <p className="text-sm text-base-content/70" role="status">
              {t("submissions.regradeAll.statusDispatching")}
            </p>
          )}
          {regradeAll.phase === "running" && (
            <Alert tone="info" role="status">
              <InlineSpinner />
              {t("submissions.regradeAll.statusRunning")}
            </Alert>
          )}
          {regradeAll.phase === "completed" && (
            <Alert tone="success" role="status">
              <Trans
                i18nKey="submissions.regradeAll.statusCompleted"
                values={{ collectLabel: t("submissions.collect.label") }}
                components={{
                  collectLabel: <span className="font-semibold" />,
                }}
              />
            </Alert>
          )}
          {regradeAll.phase === "failed" && (
            <Alert tone="error" role="status">
              {regradeAll.error instanceof Error
                ? t("submissions.regradeAll.statusFailedWithReason", {
                    reason: errorText(t, regradeAll.error),
                  })
                : t("submissions.regradeAll.statusFailed")}{" "}
              {t("submissions.regradeAll.statusFailedHint")}
            </Alert>
          )}
          {regradeAll.phase === "timeout" && (
            <Alert tone="warning" role="status">
              {t("submissions.regradeAll.statusTimeout")}
            </Alert>
          )}
        </>
      )}
      {/* Toolbar + table read as one unit: tighter gap than the page's
          section rhythm so the controls visually belong to the table. */}
      <div className="flex flex-col gap-3">
        <SubmissionsControls
          query={query}
          onQueryChange={setQuery}
          filters={filters}
          onFiltersChange={setFilters}
          sort={sort}
          onSortChange={setSort}
          isGroup={isGroupFlavor}
          acceptedAvailable={acceptedAvailable}
          passingAvailable={passingEnabled}
          sections={sections}
          onShare={() => setAcceptOpen(true)}
          sortHint={
            showPendingHiddenHint ? (
              <HelpTooltip
                help={t("submissions.filters.pendingHiddenHint")}
                icon={AlertIcon}
              />
            ) : undefined
          }
          // A bare empty_repo assignment has no collect at all. A no_autograder
          // assignment IS collected now (its submissions are detected rather than
          // graded), so it keeps the freshness line and the re-collect button.
          leading={
            isEmptyRepoAssignment ? undefined : (
              <DataFreshness
                lastCollectedLabel={lastCollectedLabel}
                stale={snapshotStale}
                collecting={collecting}
                errorCount={liveErrorCount}
                onRefresh={
                  collecting || emptyRoster.show
                    ? undefined
                    : () => {
                        // Collect now = re-collect (rebuild scores.json). Re-read the org
                        // repo list too so the staleness line re-derives against the
                        // newest pushes (latestPush would otherwise stay frozen at
                        // page load), and re-run the live fan-out for a live-capable
                        // viewer so presence refreshes alongside the dispatched
                        // collect.
                        collectScores.collect()
                        refetchOrgRepos()
                        if (liveCapable) {
                          refetchLive()
                        }
                        if (detectionCapable) {
                          refetchDetected()
                        }
                      }
                }
              />
            )
          }
          trailing={
            <>
              {/* Team-mode groups are managed on their own page (create,
                  members, visibility, snapshot); the per-row manage-group
                  dialog stays for quick fixes. */}
              {isTeamAssignment && (
                <RouterButton
                  variant="outline"
                  size="sm"
                  to="/$org/$classroom/assignments/$assignment/groups"
                  params={{ org, classroom, assignment }}
                >
                  <PeopleIcon aria-hidden="true" className="size-4" />
                  {t("manageGroups.title")}
                </RouterButton>
              )}
              {/* Clone submissions (CLI) — icon-only so the toolbar stays
                  compact; opens a modal with the `gh teacher download`
                  command. See https://github.com/foundation50/classroom50/issues/724. */}
              <Button
                variant="outline"
                size="sm"
                shape="square"
                title={t("submissions.cloneAll.buttonTitle")}
                aria-label={t("submissions.cloneAll.buttonTitle")}
                onClick={() => setCloneCliOpen(true)}
              >
                <DownloadIcon aria-hidden="true" className="size-4" />
              </Button>
              <SubmissionsActionsMenu
                collecting={collecting}
                regrading={regrading}
                regradeAllActive={regradeAllActive}
                canRegradeAll={canRegradeAll}
                emptyRoster={emptyRoster.show}
                skipsGrading={skipsGrading}
                // Metrics summarizes the GRADED snapshot, and computeStats skips
                // every `pending` row — so hide it whenever an overlay is adding
                // those rows, live or detection. Keying this on liveCapable alone
                // left it reachable for a no_autograder assignment, where detection
                // supplies every row: the modal would report 0 submitted while the
                // table listed detected submitters right next to it.
                onMetrics={
                  overlayCapable ? undefined : () => setMetricsOpen(true)
                }
                onCollect={() => collectScores.collect()}
                onRegradeAll={() => setRegradeConfirmOpen(true)}
                // Bulk-open Feedback PRs: owner-only (needs admin on every repo,
                // like the live reads), never for empty_repo (no PRs). A
                // no_autograder repo is templated and PERMITS the Feedback PR, so
                // it is gated on empty_repo only, not on skipsGrading.
                onOpenAllPrs={
                  isOwner &&
                  !isEmptyRepoAssignment &&
                  allAssignmentRepos.length > 0
                    ? () => setOpenAllPrsOpen(true)
                    : undefined
                }
                viewHref={viewRun?.html_url || viewWorkflowUrl}
                viewLabel={viewLabel}
                onDownloadCsv={downloadScoresCsv}
                downloadDisabled={!scoresInfo.length && !nonSubmitters.length}
                onDownloadAll={() => setDownloadAllOpen(true)}
                downloadAllDisabled={downloadableOwners.length === 0}
                // Bulk set student repo access: owner-only (needs admin on every
                // repo), individual assignments only (a group repo's membership is
                // founder-managed), never empty_repo, and only when repos exist.
                onBulkAccess={
                  isOwner &&
                  !isGroupFlavor &&
                  !isEmptyRepoAssignment &&
                  acceptedSet.size > 0
                    ? () => setBulkAccessOpen(true)
                    : undefined
                }
                // Bulk set repo features: same gate as bulk access. Reconciles
                // existing repos with the assignment's repo_features (which apply at
                // accept-time only).
                onBulkFeatures={
                  isOwner &&
                  !isGroupFlavor &&
                  !isEmptyRepoAssignment &&
                  acceptedSet.size > 0
                    ? () => setBulkFeaturesOpen(true)
                    : undefined
                }
                // Bulk change repo visibility (issue #766): same gate as bulk
                // features. Flips existing repos public/private — the
                // assignment's repo_visibility applies at accept-time only.
                onBulkVisibility={
                  isOwner &&
                  !isGroupFlavor &&
                  !isEmptyRepoAssignment &&
                  acceptedSet.size > 0
                    ? () => setBulkVisibilityOpen(true)
                    : undefined
                }
                // Bulk retrofit autograding triggers: same gate as bulk features
                // plus default-autograder only — teacher-authored (custom) shims
                // are never rewritten, and a no_autograder assignment has no shim
                // to retrofit (skipsGrading). Reconciles existing repos with the
                // assignment's submission_mode (baked into shims at accept time).
                // Requires a resolved entry — see assignmentResolved.
                onBulkTrigger={
                  isOwner &&
                  !isGroupFlavor &&
                  !skipsGrading &&
                  assignmentResolved &&
                  isDefaultAutograder(assignmentInfo.autograder) &&
                  acceptedSet.size > 0
                    ? () => setBulkTriggerOpen(true)
                    : undefined
                }
                // Pause / Resume autograding across every accepted repo — flips each
                // autograde workflow's Actions state (no file edit). Same gate as
                // the trigger retrofit (owner + individual + resolved default
                // autograder + accepted repos exist).
                onBulkPause={
                  isOwner &&
                  !isGroupFlavor &&
                  !skipsGrading &&
                  assignmentResolved &&
                  isDefaultAutograder(assignmentInfo.autograder) &&
                  acceptedSet.size > 0
                    ? () => setBulkPauseOpen(true)
                    : undefined
                }
                onBulkResume={
                  isOwner &&
                  !isGroupFlavor &&
                  !skipsGrading &&
                  assignmentResolved &&
                  isDefaultAutograder(assignmentInfo.autograder) &&
                  acceptedSet.size > 0
                    ? () => setBulkResumeOpen(true)
                    : undefined
                }
                locked={isLockedAssignment}
                lockPending={setLock.isPending}
                // Lock/unlock is an authoring-tier action (teacher|hta), same gate
                // as Regrade all; a plain TA doesn't see it (GitHub 403s them too).
                onLockToggle={
                  canRegradeAll ? () => setLockConfirmOpen(true) : undefined
                }
                closed={isClosedAssignment}
                // Close/reopen submission: authoring tier + individual, non-empty
                // repo shape (a group repo's membership is founder-managed). Unlike
                // bulk access it does NOT require acceptedSet.size > 0 — closing
                // still blocks future accepts when no one has accepted yet.
                onCloseToggle={
                  canRegradeAll &&
                  isOwner &&
                  !isGroupFlavor &&
                  !isEmptyRepoAssignment
                    ? () => setCloseSubmissionOpen(true)
                    : undefined
                }
                // Delete: same gate as the assignments table's mutating row
                // actions (author + unarchived classroom).
                onDelete={
                  canRegradeAll && !classroomArchived
                    ? () => setDeleteConfirmOpen(true)
                    : undefined
                }
              />
            </>
          }
        />
        {/* Dense-content skip (Primer): keyboard users can jump past the
            whole submissions table instead of tabbing through every row's
            links and actions. Mirrors the global skip-to-main recipe. */}
        <Button
          as="a"
          href="#after-submissions-table"
          variant="primary"
          size="sm"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:start-3 focus:z-50"
        >
          {t("submissions.skipPastTable")}
        </Button>
        <SubmissionsTable
          scores={visibleRows}
          students={students}
          nonSubmitters={visibleNonSubmitters}
          unsubmittedGroupRepos={visibleGroupRepos}
          isGroup={isGroupFlavor}
          isTeam={isTeamAssignment}
          groupDisplayNames={groupDisplayNames}
          groupMemberLogins={groupMemberLogins}
          teamsByOwner={isTeamAssignment ? teamByOwner : undefined}
          teamFormation={
            isTeamAssignment ? assignmentInfo?.team_formation : undefined
          }
          org={org}
          classroom={classroom}
          assignment={assignment}
          assignmentName={assignmentInfo?.name}
          maxGroupSize={assignmentInfo?.max_group_size}
          acceptedUsernames={acceptedAvailable ? acceptedSet : undefined}
          thresholdFraction={thresholdFraction}
          filtered={hasActiveFilter}
          onClearFilters={clearFilters}
          emptyRepoAssignment={isEmptyRepoAssignment}
          skipsGrading={skipsGrading}
          // Per-row trigger retrofit: owner + default-autograder only (teacher-
          // authored shims are never rewritten). Mirrors the bulk-action gate,
          // including assignmentResolved.
          submissionMode={
            isOwner &&
            !skipsGrading &&
            assignmentResolved &&
            isDefaultAutograder(assignmentInfo.autograder)
              ? resolveSubmissionMode(assignmentInfo.submission_mode)
              : undefined
          }
          submissionTags={assignmentInfo?.submission_tags}
          // The assignment's real submission_mode (independent of the autograder
          // gate above) — drives the type-aware submission-details modal and the
          // count wording, which apply regardless of who authored the shim.
          assignmentMode={resolveSubmissionMode(
            assignmentInfo?.submission_mode,
          )}
          // Score override: staff may enter/edit scores. Gated on an org OWNER
          // (the same write-capability gate every other mutating control on this
          // page uses — a non-owner can't write the config repo's scores.json, so
          // the editor must not appear for them). Two modes:
          //   - manual: a resolved manual-mode assignment with a valid
          //     max_points; the modal uses that configured max.
          //   - auto: a gradable autograded assignment (not off, not skipping
          //     grading); the modal overrides the autograded result using each
          //     row's own max-score. `mode` absent reads as auto.
          // Group entry keys on the founder (row owner).
          overrideGrade={
            isOwner && assignmentInfo?.grading?.mode === "manual"
              ? typeof assignmentInfo.grading.max_points === "number"
                ? {
                    org,
                    classroom,
                    assignment,
                    assignmentType: isTeamAssignment
                      ? "team"
                      : isGroupAssignment
                        ? "group"
                        : "individual",
                    mode: "manual" as const,
                    maxPoints: assignmentInfo.grading.max_points,
                  }
                : undefined
              : isOwner &&
                  !skipsGrading &&
                  assignmentResolved &&
                  assignmentInfo.grading?.mode !== "off"
                ? {
                    org,
                    classroom,
                    assignment,
                    assignmentType: isTeamAssignment
                      ? "team"
                      : isGroupAssignment
                        ? "group"
                        : "individual",
                    mode: "auto" as const,
                  }
                : undefined
          }
          // Per-row Pause/Resume autograding: same gate as the bulk pause/resume
          // (owner + individual + resolved default-autograder). Kept separate from
          // submissionMode so the row action doesn't inherit the trigger action's
          // group-assignment reach.
          canPauseAutograding={
            isOwner &&
            !isGroupFlavor &&
            !skipsGrading &&
            assignmentResolved &&
            isDefaultAutograder(assignmentInfo.autograder)
          }
          // Per-repo visibility toggle in the manage hub (issue #766): owner-
          // only — org policy blocks members from flipping visibility, and
          // GitHub 403s them regardless. Every repo shape qualifies (a bare or
          // group repo is still showcaseable).
          canChangeVisibility={isOwner}
          publicRepoNames={publicRepoNames}
          initialLoading={initialLoading}
          nonSubmittersLoading={
            !nonSubmittersReady &&
            students.length > 0 &&
            showsNonSubmitters(effectiveFilters)
          }
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          sort={sort}
          onSortChange={setSort}
          // Re-stagger the row entrance whenever the view changes (filter/sort/
          // size/assignment — search deliberately excluded). Combined with
          // `page` inside the table.
          viewSignature={animationSignature}
          // The current page's live/detected data is still resolving, so the
          // count + last-submitted cells shimmer until they settle. Gated on
          // overlayCapable so a snapshot-only view never shows a settling
          // affordance; each pending flag is already false unless its own overlay
          // is enabled, so a detection-only view (no_autograder) still shimmers.
          settling={overlayCapable && (livePending || detectedPending)}
        />
        {/* The skip link's landing point, focusable so focus actually moves. */}
        <span id="after-submissions-table" tabIndex={-1} />
      </div>
      <ConfirmModal
        open={regradeConfirmOpen}
        title={t("submissions.regradeAll.confirmTitle", {
          name: assignmentInfo?.name ?? assignment,
        })}
        description={
          <>
            {t("submissions.regradeAll.confirmBody1")}
            <br />
            <br />
            <Trans
              i18nKey="submissions.regradeAll.confirmBody2"
              values={{ collectLabel: t("submissions.collect.label") }}
              components={{
                collectLabel: <span className="font-semibold" />,
              }}
            />
          </>
        }
        confirmText="regrade"
        confirmLabel={t("submissions.regradeAll.label")}
        cancelLabel={t("common.cancel")}
        dangerous={false}
        needsConfirm={false}
        onConfirm={async () => {
          regradeAll.regrade()
        }}
        onClose={() => setRegradeConfirmOpen(false)}
      />
      <ConfirmModal
        open={lockConfirmOpen}
        title={
          isLockedAssignment
            ? t("submissions.lock.unlockTitleModal")
            : t("submissions.lock.lockTitleModal")
        }
        description={
          <Trans
            i18nKey={
              isLockedAssignment
                ? "submissions.lock.unlockDescription"
                : "submissions.lock.lockDescription"
            }
            values={{ assignment: assignmentInfo?.name ?? assignment }}
            components={{ assignment: <span className="font-semibold" /> }}
          />
        }
        confirmLabel={
          isLockedAssignment
            ? t("submissions.lock.unlockLabel")
            : t("submissions.lock.lockLabel")
        }
        cancelLabel={t("common.cancel")}
        dangerous={!isLockedAssignment}
        needsConfirm={false}
        onConfirm={async () => {
          await setLock.mutateAsync({
            org,
            classroom,
            slug: assignment,
            locked: !isLockedAssignment,
          })
        }}
        onClose={() => setLockConfirmOpen(false)}
      />
      {/* Delete-assignment confirm: the assignments table's typed-slug flow. */}
      <ConfirmModal
        open={deleteConfirmOpen}
        title={t("assignments.table.deleteTitle")}
        description={
          <Trans
            i18nKey="assignments.table.deleteDescription"
            values={{
              assignment: assignmentInfo?.name ?? assignment,
              classroom: `${org}/${classroom}`,
            }}
            components={{
              assignment: <EmphasisLtr className="text-base-content" />,
              classroom: <EmphasisLtr className="text-base-content" />,
            }}
          />
        }
        confirmText={assignment}
        confirmLabel={t("assignments.table.deleteConfirm")}
        cancelLabel={t("assignments.table.deleteCancel")}
        dangerous
        onConfirm={async () => {
          await deleteAssignmentMutation.mutateAsync({
            org,
            classroom,
            assignment,
          })
          // Refresh the assignments list we're about to land on (not awaited —
          // this page is going away anyway).
          void queryClient.invalidateQueries({
            queryKey: githubKeys.jsonFile(
              org,
              CONFIG_REPO,
              `${classroom}/assignments.json`,
            ),
          })
          await navigate({
            to: "/$org/$classroom/assignments",
            params: { org, classroom },
          })
        }}
        onClose={() => setDeleteConfirmOpen(false)}
      />
      <MetricsModal
        open={metricsOpen && !overlayCapable}
        onClose={() => setMetricsOpen(false)}
        isGroup={isGroupFlavor}
        submitted={stats.submitted}
        rosterCount={scopedStudents.length}
        avgScore={avgScore}
        maxScore={scopedScores?.[0]?.["max-score"]}
        notAvailableLabel={t("submissions.stats.notAvailable")}
        passing={stats.passing}
        passingEnabled={passingEnabled}
        passingDenom={stats.passing + stats.failing}
        failing={stats.failing}
        ungraded={stats.ungraded}
        onShowFailing={showFailing}
        acceptedAvailable={acceptedAvailable}
        acceptedCount={acceptedCount}
        acceptedNotSubmitted={acceptedNotSubmittedCount}
        onShowAcceptedNotSubmitted={showAcceptedNotSubmitted}
      />
      <AcceptLinkModal
        open={acceptOpen}
        onClose={() => setAcceptOpen(false)}
        url={assignmentSubmitUrl}
        cli={assignmentSubmitCli}
        hasSecret={Boolean(secret)}
        org={org}
        classroom={classroom}
        classroomName={classroomMeta?.name || classroomMeta?.short_name}
        summary={acceptShareSummary}
      />
      <OpenAllFeedbackPrsModal
        open={openAllPrsOpen}
        onClose={() => setOpenAllPrsOpen(false)}
        org={org}
        assignmentName={assignmentInfo?.name ?? assignment}
        mode={isGroupFlavor ? "group" : "individual"}
        repos={allAssignmentRepos}
      />
      <DownloadAllSubmissionsModal
        open={downloadAllOpen}
        onClose={() => setDownloadAllOpen(false)}
        org={org}
        classroom={classroom}
        assignment={assignment}
        assignmentName={assignmentInfo?.name ?? assignment}
        owners={downloadableOwners}
      />
      <CloneSubmissionsModal
        open={cloneCliOpen}
        onClose={() => setCloneCliOpen(false)}
        cli={cloneSubmissionsCli}
      />
      <BulkRepoAccessModal
        open={bulkAccessOpen}
        onClose={() => setBulkAccessOpen(false)}
        org={org}
        classroom={classroom}
        assignment={assignment}
        owners={acceptedOwners}
        students={students}
      />
      <BulkRepoFeaturesModal
        open={bulkFeaturesOpen}
        onClose={() => setBulkFeaturesOpen(false)}
        org={org}
        classroom={classroom}
        assignment={assignment}
        owners={acceptedOwners}
        students={students}
      />
      <BulkRepoVisibilityModal
        open={bulkVisibilityOpen}
        onClose={() => setBulkVisibilityOpen(false)}
        org={org}
        classroom={classroom}
        assignment={assignment}
        owners={acceptedOwners}
        students={students}
      />
      {/* Mounted only once resolved so the retrofit payload can't depend on the
          opener's gate — see assignmentResolved. */}
      {assignmentResolved && (
        <BulkSubmissionTriggerModal
          open={bulkTriggerOpen}
          onClose={() => setBulkTriggerOpen(false)}
          org={org}
          classroom={classroom}
          assignment={assignment}
          submissionMode={resolveSubmissionMode(assignmentInfo.submission_mode)}
          submissionTags={assignmentInfo.submission_tags}
          owners={acceptedOwners}
          students={students}
        />
      )}
      <BulkAutogradeStateModal
        open={bulkPauseOpen}
        onClose={() => setBulkPauseOpen(false)}
        org={org}
        classroom={classroom}
        assignment={assignment}
        action="pause"
        owners={acceptedOwners}
        students={students}
      />
      <BulkAutogradeStateModal
        open={bulkResumeOpen}
        onClose={() => setBulkResumeOpen(false)}
        org={org}
        classroom={classroom}
        assignment={assignment}
        action="resume"
        owners={acceptedOwners}
        students={students}
      />
      <CloseSubmissionModal
        open={closeSubmissionOpen}
        onClose={() => setCloseSubmissionOpen(false)}
        org={org}
        classroom={classroom}
        assignment={assignment}
        mode={isClosedAssignment ? "reopen" : "close"}
        owners={acceptedOwners}
        students={students}
      />
    </PageShell>
  )
}

// The teacher gradebook. Students who land here directly (e.g., an old link) are
// redirected to their own submission view; we wait for the role to resolve so a
// real teacher never bounces, and avoid firing teacher-only reads for a student.
const SubmissionsPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.submissions"))
  const { org, classroom, assignment } = useParams({ strict: false })
  const { role, roleResolved } = useClassroomRoleContext()

  if (!roleResolved) {
    return <RoleResolvingFallback className="min-h-screen" />
  }

  if (
    !can("viewClassroomStaffContent", { classroomRole: role }) &&
    org &&
    classroom &&
    assignment
  ) {
    return (
      <Navigate
        to="/$org/$classroom/assignments/$assignment/submission"
        params={{ org, classroom, assignment }}
        replace
      />
    )
  }

  return (
    <RegradeCoordinatorProvider>
      <SubmissionsPageContent />
    </RegradeCoordinatorProvider>
  )
}

export default SubmissionsPage
