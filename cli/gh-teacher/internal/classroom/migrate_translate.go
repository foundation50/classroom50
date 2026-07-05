package classroom

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// migrateSourceGitHubClassroom is the only origin string written
// into migrated_from.source today; future sources add siblings.
const migrateSourceGitHubClassroom = "github_classroom"

// shortNameDeriveReplace replaces every char outside [a-z0-9] with
// a hyphen before the runs-of-hyphens collapse.
var shortNameDeriveReplace = regexp.MustCompile(`[^a-z0-9]+`)

// deriveShortName slugifies a free-form classroom name into a value that passes
// ShortNamePattern (lowercase → replace non-alnum with `-` → collapse → trim →
// truncate to 39 → validate). On failure returns an error asking for an
// explicit --short-name.
func deriveShortName(raw string) (string, error) {
	lowered := strings.ToLower(strings.TrimSpace(raw))
	if lowered == "" {
		return "", errors.New("classroom name is empty — pass --short-name <name> explicitly")
	}
	slug := shortNameDeriveReplace.ReplaceAllString(lowered, "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > 39 {
		slug = strings.TrimRight(slug[:39], "-")
	}
	if !validate.ShortNamePattern.MatchString(slug) {
		return "", fmt.Errorf("could not derive a valid short-name from %q (got %q after slugify, fails %s) — pass --short-name <name> explicitly", raw, slug, validate.ShortNamePatternDescription)
	}
	return slug, nil
}

// classroomMigratedFromFromDetail builds the classroom-level
// migrated_from block from a source classroom and write timestamp.
func classroomMigratedFromFromDetail(detail classroomDetail, migratedAt time.Time) *configrepo.MigratedFromRef {
	return &configrepo.MigratedFromRef{
		Source:           migrateSourceGitHubClassroom,
		ClassroomID:      detail.ID,
		OriginalName:     detail.Name,
		OriginalOrgLogin: detail.Organization.Login,
		URL:              detail.URL,
		MigratedAt:       migratedAt.UTC().Format(time.RFC3339),
	}
}

// assignmentToEntry maps a source assignment + resolved target template ref
// into the on-disk AssignmentEntry. targetTemplate is the post-copy repo; the
// source starter lives in migrated_from.starter_repo. Errors on invalid shapes.
func assignmentToEntry(
	detail classroomAssignmentDetail,
	classroomID int64,
	targetTemplate assignment.TemplateRef,
	migratedAt time.Time,
) (assignment.AssignmentEntry, error) {
	if detail.Slug == "" {
		return assignment.AssignmentEntry{}, fmt.Errorf("source assignment %d has empty slug", detail.ID)
	}
	if err := validate.ShortName(detail.Slug, "slug"); err != nil {
		return assignment.AssignmentEntry{}, fmt.Errorf("source assignment %d: %w", detail.ID, err)
	}
	if !assignment.IsValidAssignmentMode(detail.Type) {
		return assignment.AssignmentEntry{}, fmt.Errorf("source assignment %d (%q) has unknown type %q (must be one of %v)", detail.ID, detail.Slug, detail.Type, assignment.AssignmentModes)
	}

	// Deadline is nullable in source; a non-null value is dropped unless it
	// parses as RFC 3339 WITH an offset — `due` is advisory, and a zone-less
	// value has no knowable zone (guessing UTC would shift the deadline). A
	// valid deadline normalizes to UTC, with the source value kept in due_meta.
	due := ""
	var dueProvenance *assignment.DueMeta
	if detail.Deadline != nil {
		// loc is unused for an offset-bearing value; the hadOffset guard
		// rejects the zone-less case.
		if t, hadOffset, err := assignment.ParseDueTime(*detail.Deadline, time.UTC); err == nil && hadOffset {
			due = t.UTC().Format(time.RFC3339)
			dueProvenance = assignment.NewDueMeta(*detail.Deadline, t, assignment.DueSourceMigrated)
		}
	}

	mig := &assignment.MigratedFromRef{
		Source:       migrateSourceGitHubClassroom,
		ClassroomID:  classroomID,
		AssignmentID: detail.ID,
		InviteLink:   detail.InviteLink,
		MigratedAt:   migratedAt.UTC().Format(time.RFC3339),
	}
	if detail.StarterCodeRepo != nil {
		mig.StarterRepo = detail.StarterCodeRepo.FullName
	}

	// Group assignments need a usable max_group_size. Use the source's
	// max_teams when sane (2..cap); else fall back to the cap so migration
	// never fails on a missing/odd value (the teacher can tighten it later).
	maxGroupSize := 0
	if detail.Type == assignment.ModeGroup {
		if detail.MaxTeams != nil && *detail.MaxTeams >= 2 && *detail.MaxTeams <= assignment.MaxGroupSizeCap {
			maxGroupSize = *detail.MaxTeams
		} else {
			maxGroupSize = assignment.MaxGroupSizeCap
		}
	}

	return assignment.AssignmentEntry{
		Slug:         detail.Slug,
		Name:         detail.Title,
		Template:     &targetTemplate,
		Due:          due,
		DueMeta:      dueProvenance,
		Mode:         detail.Type,
		MaxGroupSize: maxGroupSize,
		Autograder:   defaultAutograderName,
		MigratedFrom: mig,
	}, nil
}

// migrationPlan aggregates everything discovery collected from the
// source — the input to the template-copy + commit phases.
type migrationPlan struct {
	Classroom   classroomDetail
	Assignments []classroomAssignmentDetail
	TargetOrg   string
	ShortName   string
	Term        string
	MigratedAt  time.Time
}

// countsByMode returns (individual, group, other) tallies.
func (p migrationPlan) countsByMode() (individual, group, other int) {
	for _, a := range p.Assignments {
		switch a.Type {
		case assignment.ModeIndividual:
			individual++
		case assignment.ModeGroup:
			group++
		default:
			other++
		}
	}
	return individual, group, other
}
