// Barrel for the domain student-roster write layer. The operations were split
// by concern into ./students/* sub-modules; this file preserves the public
// `@/domain/students` surface so importers are unchanged. Shared roster
// primitives (team resolution, the roster-write tree, invite/retry helpers, the
// error classes) live in the leaf ./students/rosterPrimitives, which the
// operation modules import downward. New operations go in the matching
// sub-module, not here.
export {
  resolveTeamIdForRoleRead,
  resolveClassroomPendingInvite,
  matchesRosterRow,
  normalizeGithubUsername,
  isLikelyGithubUsername,
  StudentAlreadyEnrolledError,
  NoNewStudentsError,
  RosterCsvMalformedError,
  type ClassroomPendingInvite,
} from "./students/rosterPrimitives"
export {
  addStudentToClassroom,
  addStudentToClassroomWithConflictRetry,
  inviteByEmail,
  enrollStudentInClassroom,
  type AddStudentToClassroomResult,
  type InviteByEmailResult,
} from "./students/enrollment"
export {
  addStudentsToClassroom,
  addStudentsToClassroomWithConflictRetry,
  bulkEnrollStudentsInClassroom,
  type ImportRosterRow,
  type AddStudentsToClassroomInput,
  type AddStudentsToClassroomResult,
  type BulkEnrollStudentsResult,
  type BulkImportResult,
} from "./students/bulkEnrollment"
export {
  syncRosterFromTeam,
  type SyncRosterFromTeamResult,
} from "./students/rosterSync"
export {
  writeClassroomRoles,
  applyClassroomRoleChange,
  assignRosterMemberRole,
  resolveRosterUploadPreflight,
  type WriteClassroomRolesInput,
  type ApplyClassroomRoleChangeInput,
  type ApplyClassroomRoleChangeResult,
  type AssignRosterMemberRoleInput,
  type AssignRosterMemberRoleResult,
  type ResolveRosterUploadPreflightInput,
} from "./students/roleWrites"
export {
  migrateRosterFile,
  type MigrateRosterFileResult,
} from "./students/rosterMigration"
export {
  inviteRosterStudents,
  bulkInviteByEmail,
  type InviteRosterStudentsInput,
  type InviteRosterStudentsResult,
  type BulkInviteByEmailInput,
  type BulkInviteByEmailResult,
} from "./students/inviteRoster"
export {
  unenrollStudent,
  bulkUnenrollStudents,
  type UnenrollStudentInput,
  type BulkUnenrollProgress,
  type BulkUnenrollStudentsInput,
  type BulkUnenrollStudentsResult,
} from "./students/unenroll"
export {
  updateStudent,
  updateStudentWithConflictRetry,
  type StudentEditableFields,
  type UpdateStudentInput,
  type UpdateStudentResult,
} from "./students/updateStudent"

// The roster.csv parse/serialize layer lives in util/rosterCsv (pure, no
// GitHubClient dependency). Re-exported here so existing importers of these
// symbols from "@/domain/students" keep working unchanged.
export {
  STUDENT_CSV_FIELDS,
  normalizeStudentRow,
  splitName,
  parseRosterCsv,
  formatRosterProblems,
  parseStudentsCsv,
  stringifyStudentsCsv,
} from "@/util/rosterCsv"
export type {
  StudentCsvRow,
  RosterCsvProblem,
  ParsedRosterCsv,
} from "@/util/rosterCsv"
