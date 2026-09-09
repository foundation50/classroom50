import { describe, expect, it } from "vitest"
import { memberStatusBadges } from "./orgMemberUI"
import type { OrgMemberRow } from "./orgMembers"

const row = (over: Partial<OrgMemberRow>): OrgMemberRow => ({
  key: "k",
  username: "",
  github_id: "",
  name: "",
  email: "",
  emails: [],
  isMember: true,
  classrooms: [],
  classification: "member-on-roster",
  unprovisionedClassrooms: [],
  ...over,
})

describe("memberStatusBadges", () => {
  it("shows nothing for a healthy member", () => {
    expect(memberStatusBadges(row({}))).toEqual([])
    expect(
      memberStatusBadges(row({ classification: "member-no-roster" })),
    ).toEqual([])
  })

  it("maps each stranded classification to one chip", () => {
    expect(
      memberStatusBadges(
        row({ isMember: false, classification: "on-roster-not-member" }),
      ).map((b) => b.labelKey),
    ).toEqual(["orgMembers.badgeNotMember"])
    expect(
      memberStatusBadges(
        row({ isMember: false, classification: "invitation-pending" }),
      ).map((b) => b.labelKey),
    ).toEqual(["orgMembers.badgeInvitePending"])
    expect(
      memberStatusBadges(
        row({ isMember: false, classification: "unlinked" }),
      ).map((b) => b.labelKey),
    ).toEqual(["orgMembers.badgeUnlinked"])
  })

  it("pairs the roster's expired chip with the classification, failure first", () => {
    const badges = memberStatusBadges(
      row({
        isMember: false,
        classification: "unlinked",
        failed_invitation: {
          id: 1,
          kind: "expired",
          failed_at: null,
          reason: null,
        },
      }),
    )
    expect(badges.map((b) => b.labelKey)).toEqual([
      "students.statusInviteExpired",
      "orgMembers.badgeUnlinked",
    ])
    expect(badges[0].tone).toBe("error")
  })

  it("flags CSV/team drift for members only", () => {
    expect(
      memberStatusBadges(row({ unprovisionedClassrooms: ["cs101"] })).map(
        (b) => b.labelKey,
      ),
    ).toEqual(["orgMembers.unprovisionedBadge"])
    expect(
      memberStatusBadges(
        row({
          isMember: false,
          classification: "on-roster-not-member",
          unprovisionedClassrooms: ["cs101"],
        }),
      ).map((b) => b.labelKey),
    ).toEqual(["orgMembers.badgeNotMember"])
  })
})
