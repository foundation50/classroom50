import { describe, expect, it, vi, beforeEach } from "vitest"

const getClassroomJson = vi.fn()
const migrate = vi.fn()
const ensureClassroomTeam = vi.fn()
const ensureStaffTeams = vi.fn()
const reconcileDescription = vi.fn()

vi.mock("@/github-core/configRepoReads", () => ({
  getClassroomJson: (...a: unknown[]) => getClassroomJson(...a),
}))
vi.mock("@/github-core/mutations", () => ({
  ensureClassroomTeam: (...a: unknown[]) => ensureClassroomTeam(...a),
  ensureStaffTeams: (...a: unknown[]) => ensureStaffTeams(...a),
  migrateInstructorTeamToTeacher: (...a: unknown[]) => migrate(...a),
  reconcileStudentTeamDescription: (...a: unknown[]) =>
    reconcileDescription(...a),
}))

import { reconcileClassroom } from "./reconcileClassroom"
import { ClassroomReconcilePermanentError } from "./reconcileClassroom"
import { GitHubAPIError } from "@/github-core/errors"

const client = {} as never

function githubAPIError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "/orgs/org/teams/classroom50-cs101",
    message: `status ${status}`,
    body: {},
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  })
}

beforeEach(() => {
  getClassroomJson.mockReset()
  migrate.mockReset()
  ensureClassroomTeam.mockReset()
  ensureStaffTeams.mockReset()
  reconcileDescription.mockReset()
  // Healthy defaults: active classroom, everything already converged.
  getClassroomJson.mockResolvedValue({ name: "CS101", active: true })
  migrate.mockResolvedValue({ changed: false })
  ensureClassroomTeam.mockResolvedValue({
    id: 1,
    slug: "classroom50-cs101",
    created: false,
  })
  ensureStaffTeams.mockResolvedValue({ teams: {}, created: [] })
  reconcileDescription.mockResolvedValue({ changed: false })
})

describe("reconcileClassroom", () => {
  it("is a no-op on a healthy classroom and reports no change", async () => {
    const result = await reconcileClassroom(client, "org", "cs101")
    expect(result).toEqual({
      skipped: false,
      migration: { changed: false },
      description: { changed: false },
      staffCreated: [],
    })
    expect(ensureStaffTeams).toHaveBeenCalledWith(client, "org", "cs101")
    expect(ensureClassroomTeam).toHaveBeenCalledWith(client, "org", "cs101")
    expect(reconcileDescription).toHaveBeenCalledTimes(1)
  })

  it("runs the instructor->teacher migration BEFORE ensuring staff teams", async () => {
    const order: string[] = []
    migrate.mockImplementation(async () => {
      order.push("migrate")
      return { changed: false }
    })
    ensureStaffTeams.mockImplementation(async () => {
      order.push("staff")
      return { teams: {}, created: [] }
    })
    await reconcileClassroom(client, "org", "cs101")
    expect(order).toEqual(["migrate", "staff"])
  })

  it("surfaces a newly created staff team (e.g. a backfilled -hta)", async () => {
    ensureStaffTeams.mockResolvedValue({ teams: {}, created: ["hta"] })
    const result = await reconcileClassroom(client, "org", "cs101")
    expect(result.staffCreated).toEqual(["hta"])
    expect(result.skipped).toBe(false)
  })

  it("skips all writes on an archived classroom", async () => {
    getClassroomJson.mockResolvedValue({ name: "CS101", active: false })
    const result = await reconcileClassroom(client, "org", "cs101")
    expect(result).toEqual({
      skipped: true,
      migration: { changed: false },
      description: { changed: false },
      staffCreated: [],
    })
    expect(migrate).not.toHaveBeenCalled()
    expect(ensureClassroomTeam).not.toHaveBeenCalled()
    expect(ensureStaffTeams).not.toHaveBeenCalled()
    expect(reconcileDescription).not.toHaveBeenCalled()
  })

  it("treats a missing/legacy classroom.json (404) as active and reconciles", async () => {
    getClassroomJson.mockRejectedValue(githubAPIError(404))
    const result = await reconcileClassroom(client, "org", "cs101")
    expect(result.skipped).toBe(false)
    expect(ensureStaffTeams).toHaveBeenCalledTimes(1)
  })

  it("rethrows a transient classroom.json read failure without reconciling", async () => {
    getClassroomJson.mockRejectedValue(githubAPIError(503))
    await expect(reconcileClassroom(client, "org", "cs101")).rejects.toThrow()
    expect(ensureStaffTeams).not.toHaveBeenCalled()
  })

  it("aborts and rethrows if the migration fails, without touching staff teams", async () => {
    migrate.mockRejectedValue(githubAPIError(500))
    await expect(reconcileClassroom(client, "org", "cs101")).rejects.toThrow()
    expect(ensureClassroomTeam).not.toHaveBeenCalled()
    expect(ensureStaffTeams).not.toHaveBeenCalled()
    expect(reconcileDescription).not.toHaveBeenCalled()
  })

  it("aborts and rethrows if ensureStaffTeams fails, without touching the description", async () => {
    ensureStaffTeams.mockRejectedValue(githubAPIError(500))
    await expect(reconcileClassroom(client, "org", "cs101")).rejects.toThrow()
    expect(reconcileDescription).not.toHaveBeenCalled()
  })

  it("rewraps a description-step 404 as a permanent error (wrong slug never converges)", async () => {
    reconcileDescription.mockRejectedValue(githubAPIError(404))
    await expect(
      reconcileClassroom(client, "org", "cs101"),
    ).rejects.toBeInstanceOf(ClassroomReconcilePermanentError)
  })

  it("does NOT rewrap a description-step 404 when the student team was just created (create->read replication blip is transient)", async () => {
    // A just-created student team can 404 on the immediate description-step read
    // (create->read replication lag); that's transient, so it must stay a plain
    // GitHubAPIError (releasing the latch for a retry) rather than latching the
    // whole classroom heal off for the mount.
    ensureClassroomTeam.mockResolvedValue({
      id: 1,
      slug: "classroom50-cs101",
      created: true,
    })
    reconcileDescription.mockRejectedValue(githubAPIError(404))
    const err = await reconcileClassroom(client, "org", "cs101").catch((e) => e)
    expect(err).toBeInstanceOf(GitHubAPIError)
    expect(err).not.toBeInstanceOf(ClassroomReconcilePermanentError)
  })

  it("does NOT rewrap a non-404 description-step failure", async () => {
    reconcileDescription.mockRejectedValue(githubAPIError(500))
    await expect(
      reconcileClassroom(client, "org", "cs101"),
    ).rejects.not.toBeInstanceOf(ClassroomReconcilePermanentError)
  })

  it("leaves a non-description 404 (e.g. transient team read) as a plain GitHubAPIError", async () => {
    // A 404 from the migration/staff steps must stay transient (a plain
    // GitHubAPIError), not get rewrapped as permanent — only the description
    // step's wrong-slug read is unconvergeable.
    ensureStaffTeams.mockRejectedValue(githubAPIError(404))
    const err = await reconcileClassroom(client, "org", "cs101").catch((e) => e)
    expect(err).toBeInstanceOf(GitHubAPIError)
    expect(err).not.toBeInstanceOf(ClassroomReconcilePermanentError)
  })
})
