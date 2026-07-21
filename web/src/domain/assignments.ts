// Barrel for the domain assignment write layer. The operations were split by
// concern into ./assignments/* sub-modules; this file preserves the public
// `@/domain/assignments` surface so importers are unchanged. Shared scaffolding
// (template resolution/verification, the accept-step machinery, path-existence
// probes, the scoped logger, the fresh-repo error) lives in the leaf
// ./assignments/accessPrimitives, which the operation modules import downward.
// New operations go in the matching sub-module, not here.
export {
  verifyTemplateAccess,
  resolveTemplate,
  type AcceptStepId,
  type AcceptStepStatus,
  type OnAcceptStepUpdate,
  type TemplateAccessVerification,
} from "./assignments/accessPrimitives"
export {
  editAssignment,
  createAssignment,
  editAssignmentWithConflictRetry,
  preserveUnmanagedAssignmentKeys,
  tryGrantTeamTemplateRead,
  resolveTemplateGrant,
  TEMPLATE_READ_STAFF_ROLES,
  type CreateAssignmentResult,
} from "./assignments/createEdit"
export {
  createAssignmentRepo,
  createAssignmentWithConflictRetry,
  type CreateAssignmentInput,
} from "./assignments/repoCreation"
export {
  copyAssignmentToClassroom,
  copyAssignmentWithConflictRetry,
  nextAvailableSlug,
  buildReusedEntry,
  type CopyAssignmentInput,
} from "./assignments/copyReuse"
export {
  createClassroom50Yaml,
  resolveAutograderWorkflow,
} from "./assignments/autograderYaml"
export {
  deleteAssignment,
  type DeleteAssignmentInput,
} from "./assignments/deleteAssignment"
export {
  addFounderCollaborator,
  permissionSatisfies,
  founderPermission,
  assertAssignmentModeCoherent,
} from "./assignments/permissions"
export { acceptAssignment } from "./assignments/accept"
export {
  submitAssignment,
  normalizeRepoPath,
  isReservedUploadPath,
  type UploadFile,
  type SubmitAssignmentResult,
} from "./assignments/submit"
