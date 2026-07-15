// Public API for the authz feature module. The single import surface for
// everything access-control: role vocabulary, the resolution reducers the
// providers consume, the app<->GitHub role mappers, and the `can()` policy.
//
// Consumers import from `@/authz` ONLY — never the internal files
// (`@/authz/roles`, `@/authz/resolveRole`, `@/authz/capabilities`). A lint rule
// (`no-restricted-imports` on `@/authz/*` in eslint.config.js) enforces that, so
// the module's internals can be refactored without breaking callers. This is the
// one place role/authz logic lives; `can()` is the single decision surface.

// --- Role vocabulary + mappers (roles.ts) -----------------------------------
export type {
  GitHubOrgRole,
  ClassroomRole,
  ResolvedRole,
  ViewAsRole,
  GitHubTeamMembership,
} from "./roles"
export {
  ROLE_RANK,
  sortRolesByRank,
  githubOrgRoleForRole,
  roleForGitHubOrgRole,
  isOwnerGitHubOrgRole,
} from "./roles"

// --- Resolution reducers + verdict types (resolveRole.ts) -------------------
export type { ClassroomRoleInput, OrgStaffVerdict } from "./resolveRole"
export {
  resolveClassroomRole,
  resolveOrgRole,
  applyViewAs,
  roleLabelKey,
  membershipFromQuery,
} from "./resolveRole"

// --- Capability policy (capabilities.ts) ------------------------------------
export type { Capability, CapabilityInput } from "./capabilities"
export { can } from "./capabilities"
