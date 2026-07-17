package staff

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/output"
)

// MigrateInstructorTeamToTeacher advances a classroom through the two-phase
// `instructor` → `teacher` rename, idempotently. It self-heals on touch: safe
// to call before any staff op.
//
//	Phase 1 (create): a classroom that records a legacy `teams.instructor` team
//	but no canonical `teams.teacher` gets a `classroom50-<short>-teacher` team
//	created/adopted, granted config-repo write, seeded with every instructor-team
//	member, and recorded under `teams.teacher` — all in one RMW commit. The
//	`-instructor` team is left intact so older clients that still read it keep
//	working.
//
//	Phase 2 (delete): once `teams.teacher` is recorded AND the legacy
//	`-instructor` team is still present (a later touch), the instructor team is
//	deleted and then its `teams.instructor` ref dropped (see migratePhaseDelete
//	for the ordering rationale).
//
// Splitting create and delete across two touches keeps a client release that
// only reads `-instructor` from losing access mid-migration. A classroom with
// neither an instructor ref nor a teacher ref is a no-op (nothing to migrate).
func MigrateInstructorTeamToTeacher(client githubapi.Client, out io.Writer, org, classroom, branch string) error {
	c, ok, err := configrepo.LoadClassroom(client, org, classroom, branch)
	if err != nil || !ok || c.Teams == nil {
		return err
	}
	hasTeacher := c.Teams.Teacher != nil && c.Teams.Teacher.Slug != ""
	instr := c.Teams.Instructor
	hasInstructor := instr != nil && instr.Slug != ""

	switch {
	case !hasTeacher && hasInstructor:
		return migratePhaseCreate(client, out, org, classroom, branch, *instr)
	case hasTeacher && hasInstructor:
		return migratePhaseDelete(client, out, org, classroom, branch, *c.Teams.Teacher, *instr)
	default:
		return nil
	}
}

// migratePhaseCreate performs Phase 1: ensure the teacher team, grant write,
// copy instructor-team members, and record teams.teacher in one commit.
func migratePhaseCreate(client githubapi.Client, out io.Writer, org, classroom, branch string, instr configrepo.TeamRef) error {
	teacher, err := configrepo.EnsureClassroomStaffTeam(client, org, classroom, configrepo.RoleTeacher)
	if err != nil {
		return fmt.Errorf("ensure teacher team: %w", err)
	}
	if _, err := configrepo.GrantTeamRepoWrite(client, org, teacher.Slug, org, configrepo.ConfigRepoName); err != nil {
		return fmt.Errorf("grant teacher team write on %s: %w", configrepo.ConfigRepoName, err)
	}
	// Copy every instructor-team member onto the teacher team. Idempotent
	// (AddTeamMembership is a PUT), so a re-run after a partial failure heals.
	members, err := configrepo.ListTeamMembers(client, org, instr.Slug)
	if err != nil {
		return fmt.Errorf("list instructor team members: %w", err)
	}
	for _, login := range members {
		if err := configrepo.AddTeamMembershipWithRole(client, org, teacher.Slug, login, configrepo.TeamMaintainer); err != nil {
			return fmt.Errorf("copy %s to teacher team: %w", login, err)
		}
	}

	path := configrepo.ClassroomFilePath(classroom)
	message := contract.PrefixCommit(fmt.Sprintf("Migrate instructor team to teacher for %s", classroom))
	build := func(parentSHA string) (map[string]string, error) {
		data, ok, err := configrepo.ReadFileContents(client, org, configrepo.ConfigRepoName, path, parentSHA)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("%s: classroom %s not found in %s/%s", org, classroom, configrepo.ConfigRepoName, path)
		}
		var c configrepo.ClassroomJSON
		if err := json.Unmarshal(data, &c); err != nil {
			return nil, fmt.Errorf("%s/%s/%s: %w", org, configrepo.ConfigRepoName, path, err)
		}
		if c.Teams == nil {
			c.Teams = &configrepo.StaffTeamsRef{}
		}
		ref := teacher
		c.Teams.Teacher = &ref
		updated, err := output.JSONPretty(c)
		if err != nil {
			return nil, fmt.Errorf("encode classroom.json: %w", err)
		}
		if string(data) == string(updated) {
			return nil, nil // already recorded — no commit
		}
		return map[string]string{path: string(updated)}, nil
	}
	if _, err := configwrite.CommitTree(client, org, configrepo.ConfigRepoName, branch, message, build); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "%s: migrated instructor team to teacher team %s in %s\n", org, teacher.Slug, classroom)
	return nil
}

// migratePhaseDelete performs Phase 2: delete the instructor team and then drop
// its ref, now that the teacher team is recorded. Deleting before the ref drop
// means a failed delete leaves teams.instructor recorded so a later touch
// retries, rather than stranding the team beyond any ref-based reaper. A brief
// window has classroom.json still pointing at the deleted team, but Phase 1
// already seeded the teacher team, so the reader resolves via `-teacher`. A
// distinct-slug guard avoids deleting an instructor team adopted AS the teacher
// team.
func migratePhaseDelete(client githubapi.Client, out io.Writer, org, classroom, branch string, teacher, instr configrepo.TeamRef) error {
	if teacher.Slug == instr.Slug {
		// The teacher ref adopted the same team; only drop the duplicate ref.
		return dropInstructorRef(client, org, classroom, branch)
	}
	if err := configrepo.DeleteClassroomTeam(client, org, instr); err != nil {
		return fmt.Errorf("delete legacy instructor team %s: %w", instr.Slug, err)
	}
	if err := dropInstructorRef(client, org, classroom, branch); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "%s: removed legacy instructor team %s in %s\n", org, instr.Slug, classroom)
	return nil
}

// dropInstructorRef clears teams.instructor in classroom.json in one RMW commit.
func dropInstructorRef(client githubapi.Client, org, classroom, branch string) error {
	path := configrepo.ClassroomFilePath(classroom)
	message := contract.PrefixCommit(fmt.Sprintf("Drop legacy instructor team ref for %s", classroom))
	build := func(parentSHA string) (map[string]string, error) {
		data, ok, err := configrepo.ReadFileContents(client, org, configrepo.ConfigRepoName, path, parentSHA)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("%s: classroom %s not found in %s/%s", org, classroom, configrepo.ConfigRepoName, path)
		}
		var c configrepo.ClassroomJSON
		if err := json.Unmarshal(data, &c); err != nil {
			return nil, fmt.Errorf("%s/%s/%s: %w", org, configrepo.ConfigRepoName, path, err)
		}
		if c.Teams == nil || c.Teams.Instructor == nil {
			return nil, nil // already dropped — no commit
		}
		c.Teams.Instructor = nil
		updated, err := output.JSONPretty(c)
		if err != nil {
			return nil, fmt.Errorf("encode classroom.json: %w", err)
		}
		if string(data) == string(updated) {
			return nil, nil
		}
		return map[string]string{path: string(updated)}, nil
	}
	_, err := configwrite.CommitTree(client, org, configrepo.ConfigRepoName, branch, message, build)
	return err
}
