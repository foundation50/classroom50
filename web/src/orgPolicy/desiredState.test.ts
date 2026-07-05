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
  "members_can_create_public_repositories",
  "members_can_create_internal_repositories",
  "members_can_view_dependency_insights",
  "members_can_invite_outside_collaborators",
]

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
  it("returns all 16 fields on enterprise", () => {
    expect(memberDefaultSettings("enterprise")).toHaveLength(16)
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

  it("marks exactly the three enabling fields non-critical, everything else critical", () => {
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
    expect(verdicts).toHaveLength(16)
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
    live.members_can_create_public_repositories = true
    const { verdicts, criticalMissed } = classifyDefaults(live, "team")
    expect(verdicts).toHaveLength(12)
    expect(
      verdicts.some(
        (v) => v.setting.field === "members_can_create_public_repositories",
      ),
    ).toBe(false)
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
