import { describe, expect, it } from "vitest"

import {
  classifyDefaults,
  manualHardeningSteps,
  memberDefaultSettings,
} from "./desiredState"

// The desired-state module is the web mirror of the CLI's orgpolicy seam.
// These tests pin the parity-critical invariants: plan-aware field count,
// criticality flags, and the three-state classification the settings page and
// audit depend on.

const ENTERPRISE_ONLY_FIELDS = [
  "members_can_create_internal_repositories",
  "members_can_view_dependency_insights",
  "members_can_invite_outside_collaborators",
]

// Not enterprise-only: sent on every plan, with a plan-dependent VALUE. Omitting
// it off-enterprise is what made GitHub 422 the repo-creation PATCH.
const PLAN_DEPENDENT_FIELD = "members_can_create_public_repositories"

const NON_CRITICAL_FIELDS = [
  "members_can_create_private_repositories",
  "members_can_create_pages",
  "members_can_create_public_pages",
]

// A live org response with every in-scope field already at its desired value.
function enforcedLive(plan: string | undefined): Record<string, unknown> {
  const live: Record<string, unknown> = {}
  for (const s of memberDefaultSettings(plan)) {
    live[s.field] = s.value
  }
  return live
}

describe("memberDefaultSettings", () => {
  it("returns all 15 fields on enterprise", () => {
    expect(memberDefaultSettings("enterprise")).toHaveLength(15)
  })

  it.each(["team", "free", "", undefined])(
    "returns 12 fields with no enterprise-only fields on %s",
    (plan) => {
      const settings = memberDefaultSettings(plan)
      expect(settings).toHaveLength(12)
      const fields = settings.map((s) => s.field)
      for (const ent of ENTERPRISE_ONLY_FIELDS) {
        expect(fields).not.toContain(ent)
      }
    },
  )

  // Team/Free expose "Repository creation" as one all-or-none choice, so the
  // private-only lockdown isn't reachable and public creation must be enabled
  // (and sent) alongside private. Sending the private boolean WITHOUT this field
  // makes GitHub recompute the deprecated legacy field as "private" and reject
  // the whole PATCH: 422 "Private-only repository creation policy is not allowed
  // for this organization."
  it.each(["team", "free", "", undefined])(
    "enables public repo creation on %s, and keeps it in scope",
    (plan) => {
      const setting = memberDefaultSettings(plan).find(
        (s) => s.field === PLAN_DEPENDENT_FIELD,
      )
      expect(setting).toBeDefined()
      expect(setting?.value).toBe(true)
      // The master switch already carries the critical verdict for repo creation.
      expect(setting?.critical).toBe(false)
    },
  )

  // Both granular booleans are verify-only off-enterprise: GitHub derives them
  // from the master switch and 422s any PATCH that carries one. The master switch
  // itself stays writable — it's the only accepted write.
  it.each(["team", "free", "", undefined])(
    "marks the granular repo-creation booleans verify-only on %s",
    (plan) => {
      const byField = new Map(
        memberDefaultSettings(plan).map((s) => [s.field, s]),
      )
      expect(byField.get(PLAN_DEPENDENT_FIELD)?.writable).toBe(false)
      expect(
        byField.get("members_can_create_private_repositories")?.writable,
      ).toBe(false)
      expect(byField.get("members_can_create_repositories")?.writable).not.toBe(
        false,
      )
    },
  )

  it("keeps every enterprise setting writable", () => {
    for (const s of memberDefaultSettings("enterprise")) {
      expect(s.writable, `${s.field} writability`).not.toBe(false)
    }
  })

  it("keeps the private-only lockdown on enterprise", () => {
    const setting = memberDefaultSettings("enterprise").find(
      (s) => s.field === PLAN_DEPENDENT_FIELD,
    )
    expect(setting?.value).toBe(false)
    expect(setting?.critical).toBe(true)
  })

  it("does not mutate the canonical list when overriding", () => {
    memberDefaultSettings("team")
    const afterOverride = memberDefaultSettings("enterprise").find(
      (s) => s.field === PLAN_DEPENDENT_FIELD,
    )
    expect(afterOverride?.value).toBe(false)
  })

  it("marks exactly the three enabling fields non-critical on enterprise, everything else critical", () => {
    for (const s of memberDefaultSettings("enterprise")) {
      const expectCritical = !NON_CRITICAL_FIELDS.includes(s.field)
      expect(s.critical, `${s.field} criticality`).toBe(expectCritical)
    }
  })
})

describe("classifyDefaults", () => {
  it("reports all enforced and no critical miss when live matches desired", () => {
    const { verdicts, criticalMissed } = classifyDefaults(
      enforcedLive("enterprise"),
      "enterprise",
    )
    expect(verdicts).toHaveLength(15)
    expect(verdicts.every((v) => v.enforced)).toBe(true)
    expect(criticalMissed).toBe(false)
  })

  it("flags criticalMissed when a critical field is wrong", () => {
    const live = enforcedLive("enterprise")
    live.members_can_delete_repositories = true // critical, should be false
    const { criticalMissed, verdicts } = classifyDefaults(live, "enterprise")
    expect(criticalMissed).toBe(true)
    expect(
      verdicts.find(
        (v) => v.setting.field === "members_can_delete_repositories",
      )?.enforced,
    ).toBe(false)
  })

  it("does not flag criticalMissed when only a non-critical field drifts", () => {
    const live = enforcedLive("enterprise")
    live.members_can_create_pages = false // non-critical
    const { criticalMissed, verdicts } = classifyDefaults(live, "enterprise")
    expect(criticalMissed).toBe(false)
    expect(
      verdicts.find((v) => v.setting.field === "members_can_create_pages")
        ?.enforced,
    ).toBe(false)
  })

  it("ignores enterprise-only fields on team plan even when their live value is wrong", () => {
    const live = enforcedLive("team")
    // A wrong value for an enterprise-only field must not affect a team verdict.
    live.members_can_view_dependency_insights = true
    const { verdicts, criticalMissed } = classifyDefaults(live, "team")
    expect(verdicts).toHaveLength(12)
    expect(
      verdicts.some(
        (v) => v.setting.field === "members_can_view_dependency_insights",
      ),
    ).toBe(false)
    expect(criticalMissed).toBe(false)
  })

  // Public repo creation IS in scope off-enterprise, just inverted: Team/Free
  // must have it ON (coupled to private), so public creation being OFF there is
  // drift the audit reports rather than a field it ignores.
  it("reports public repo creation as drift on team when it is off", () => {
    const live = enforcedLive("team")
    live.members_can_create_public_repositories = false
    const { verdicts, criticalMissed } = classifyDefaults(live, "team")
    const verdict = verdicts.find(
      (v) => v.setting.field === "members_can_create_public_repositories",
    )
    expect(verdict?.enforced).toBe(false)
    // Non-critical there: the master switch owns the critical repo-creation
    // verdict, so this alone must not fail the whole audit.
    expect(criticalMissed).toBe(false)
  })

  it("treats a missing live field as unenforced", () => {
    const { criticalMissed } = classifyDefaults({}, "team")
    expect(criticalMissed).toBe(true)
  })
})

describe("manualHardeningSteps", () => {
  it("returns the four manual steps pointing at the org member-privileges page", () => {
    const steps = manualHardeningSteps("acme")
    expect(steps).toHaveLength(4)
    for (const step of steps) {
      expect(step.url).toBe(
        "https://github.com/organizations/acme/settings/member_privileges",
      )
    }
  })
})
