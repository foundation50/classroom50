// Barrel for the github-core write layer. The mutations were split by resource
// into ./mutations/* sub-modules; this file preserves the public
// `@/github-core/mutations` surface so importers are unchanged. Shared git-data
// primitives + classroom-seed helpers live in the leaf ./mutations/gitObjects,
// which the provisioning + classroomEdit modules import downward. New mutations
// go in the matching sub-module, not here.
export {
  createTree,
  createTreeRepo,
  createTreeForAssignment,
  createCommit,
  createCommitRepo,
  createCommitForAssignment,
  updateRef,
  updateRefForRepo,
  createGitTree,
  createGitCommit,
  createBlob,
  createTreeFromEntries,
  type GitTreeFileMode,
  type GitTreeEntry,
  type CreateGitTreeInput,
  type CreateGitCommitInput,
} from "./mutations/gitObjects"
export {
  isDeletableClassroomTeamRef,
  ensureClassroomTeam,
  ensureClassroomRoleTeam,
  grantTeamConfigRepoWrite,
  ensureStaffTeams,
  deleteClassroomTeam,
  addRepositoryToTeam,
  addUserToTeam,
  removeUserFromTeam,
  TeamIdMismatchError,
  type ClassroomTeamRef,
  type StaffTeamRefs,
} from "./mutations/teams"
export {
  createOrgInvitation,
  cancelOrgInvitation,
  removeOrgMembership,
  setOrgMembershipRole,
  readOrgMembershipState,
  getOrgMembershipState,
  isActiveMember,
  ensureOrgMembership,
  resendOrgInvitation,
  getPendingOrgInvite,
  archiveRepo,
  deleteRepo,
  type OrgMembershipState,
} from "./mutations/orgMembership"
export {
  createOrgRepo,
  ensureClassroom50Repo,
  renameConfigRepoToMain,
  gitBlobSha,
  isNonFastForward,
  findStaleSkeletonFiles,
  ensureSkeletonFiles,
  ensurePages,
  getRepoWorkflowPermissions,
  setRepoWorkflowPermissions,
  ensureWorkflowPermissions,
  ensureReusableWorkflowAccess,
  putMinimalBranchProtection,
  ensureBranchProtection,
  ensureOrgActionsEnabled,
  ensureOrgCanCreatePullRequests,
  initClassroom50,
  type StaleSkeletonFile,
  type EnsurePagesResult,
  type EnsureWorkflowPermissionsResult,
  type EnsureReusableWorkflowAccessResult,
  type EnsureBranchProtectionResult,
  type EnsureOrgActionsEnabledResult,
  type EnsureOrgCanCreatePullRequestsResult,
  type InitStepId,
  type InitStepStatus,
  type InitStepUpdate,
} from "./mutations/provisioning"
export {
  encryptSecret,
  validateServiceToken,
  putRepoSecret,
} from "./mutations/secrets"
export {
  triggerScoreCollection,
  triggerRegrade,
  rerunFailedRun,
} from "./mutations/workflowDispatch"
export {
  addRepoCollaborator,
  removeRepoCollaborator,
} from "./mutations/collaborators"
export {
  buildClassroomUpdate,
  editClassroom,
  type UpdateClassroomMetadataInput,
  type Classroom,
  type UpdateClassroomMetadataResult,
  type EditClassroomInput,
  type EditClassroomResult,
} from "./mutations/classroomEdit"
export {
  migrateInstructorTeamToTeacher,
  type TeacherMigrationResult,
} from "./mutations/teacherMigration"
export {
  reconcileStudentTeamDescription,
  ClassroomSourceReadError,
  type TeamDescriptionReconcileResult,
} from "./mutations/teamDescription"
