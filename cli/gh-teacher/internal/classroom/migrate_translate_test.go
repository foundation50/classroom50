package classroom

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/validate"
)

func TestDeriveShortName(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"already a slug", "cs-principles", "cs-principles", false},
		// "classroom50test" doubles as the real-export single-word
		// classroom name and a digits-and-letters happy path.
		{"digits and letters / real-export name 1", "classroom50test", "classroom50test", false},
		{"spaces", "CS Principles Fall 2026", "cs-principles-fall-2026", false},
		{"real-export name 2", "CS50 Stress Test-classroom-1", "cs50-stress-test-classroom-1", false},
		{"slashes and spaces", "Intro to CS / Section 1", "intro-to-cs-section-1", false},
		{"apostrophe + em-dash", "Spring '26 — Honors", "spring-26-honors", false},
		// Truncation cap is the CREATION budget (40), not the pattern's 100.
		{"too long, truncates to the creation cap", strings.Repeat("abcdefghij-", 10), strings.Repeat("abcdefghij-", 3) + "abcdefg", false},
		// A cut landing on a hyphen is trimmed, not left dangling.
		{"truncation exposing a trailing hyphen", strings.Repeat("abcdefghi-", 10), strings.Repeat("abcdefghi-", 3) + "abcdefghi", false},
		{"leading and trailing punctuation", "—Hello—", "hello", false},
		{"empty", "", "", true},
		{"whitespace only", "   ", "", true},
		{"emoji only", "🎓📚", "", true},
		// Single char — fails shortNamePattern's 2-char minimum.
		{"single char", "a", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := deriveShortName(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("deriveShortName(%q) = %q, want error", tc.in, got)
				}
				if !strings.Contains(err.Error(), "--short-name") {
					t.Errorf("err = %q, want substring %q (actionable hint)", err.Error(), "--short-name")
				}
				return
			}
			if err != nil {
				t.Fatalf("deriveShortName(%q) = %v, want %q", tc.in, err, tc.want)
			}
			if got != tc.want {
				t.Errorf("deriveShortName(%q) = %q, want %q", tc.in, got, tc.want)
			}
			// Every successful output must pass shortNamePattern so
			// downstream callers don't reject what migrate produces.
			if !validate.ShortNamePattern.MatchString(got) {
				t.Errorf("deriveShortName(%q) = %q, fails shortNamePattern", tc.in, got)
			}
		})
	}
}

func TestResolveImportSlugs(t *testing.T) {
	// shortName "cs" leaves a 57-char budget (59 - 2).
	const shortName = "cs"
	long := strings.Repeat("s", 58)
	det := func(slug string) classroomAssignmentDetail {
		return classroomAssignmentDetail{Slug: slug, Type: "individual"}
	}
	slugs := func(out []classroomAssignmentDetail) []string {
		got := make([]string, len(out))
		for i, a := range out {
			got[i] = a.Slug
		}
		return got
	}

	t.Run("fitting slugs import verbatim with no renames", func(t *testing.T) {
		out, renames, err := resolveImportSlugs(
			[]classroomAssignmentDetail{det("hw1"), det("hw2")}, shortName, nil)
		if err != nil {
			t.Fatalf("resolveImportSlugs: %v", err)
		}
		if !reflect.DeepEqual(slugs(out), []string{"hw1", "hw2"}) || len(renames) != 0 {
			t.Errorf("got %v (%d renames), want verbatim", slugs(out), len(renames))
		}
	})

	t.Run("over-budget slug auto-trims to the budget", func(t *testing.T) {
		out, renames, err := resolveImportSlugs(
			[]classroomAssignmentDetail{det(long)}, shortName, nil)
		if err != nil {
			t.Fatalf("resolveImportSlugs: %v", err)
		}
		want := strings.Repeat("s", 57)
		if out[0].Slug != want {
			t.Errorf("slug = %q, want %q", out[0].Slug, want)
		}
		if len(renames) != 1 || renames[0].From != long || renames[0].To != want || renames[0].Explicit {
			t.Errorf("renames = %+v, want one implicit %q -> %q", renames, long, want)
		}
	})

	t.Run("two same-prefix trims suffix apart", func(t *testing.T) {
		other := strings.Repeat("s", 59)
		out, _, err := resolveImportSlugs(
			[]classroomAssignmentDetail{det(long), det(other)}, shortName, nil)
		if err != nil {
			t.Fatalf("resolveImportSlugs: %v", err)
		}
		first := strings.Repeat("s", 57)
		second := strings.Repeat("s", 55) + "-2"
		if !reflect.DeepEqual(slugs(out), []string{first, second}) {
			t.Errorf("slugs = %v, want [%q, %q]", slugs(out), first, second)
		}
	})

	t.Run("trim avoids a verbatim keeper", func(t *testing.T) {
		keeper := strings.Repeat("s", 57) // fits, imports verbatim
		out, _, err := resolveImportSlugs(
			[]classroomAssignmentDetail{det(long), det(keeper)}, shortName, nil)
		if err != nil {
			t.Fatalf("resolveImportSlugs: %v", err)
		}
		// The keeper claims s*57 first, so the trim suffixes past it.
		want := strings.Repeat("s", 55) + "-2"
		if out[0].Slug != want || out[1].Slug != keeper {
			t.Errorf("slugs = %v, want [%q, %q]", slugs(out), want, keeper)
		}
	})

	t.Run("explicit rename wins over auto-trim and is reported explicit", func(t *testing.T) {
		out, renames, err := resolveImportSlugs(
			[]classroomAssignmentDetail{det(long)}, shortName,
			map[string]string{long: "hw1"})
		if err != nil {
			t.Fatalf("resolveImportSlugs: %v", err)
		}
		if out[0].Slug != "hw1" {
			t.Errorf("slug = %q, want %q", out[0].Slug, "hw1")
		}
		if len(renames) != 1 || !renames[0].Explicit {
			t.Errorf("renames = %+v, want one explicit", renames)
		}
	})

	t.Run("unknown rename source errors", func(t *testing.T) {
		_, _, err := resolveImportSlugs(
			[]classroomAssignmentDetail{det("hw1")}, shortName,
			map[string]string{"nope": "hw2"})
		if err == nil || !strings.Contains(err.Error(), "no source assignment") {
			t.Fatalf("err = %v, want unknown-source error", err)
		}
	})

	t.Run("over-budget rename target errors", func(t *testing.T) {
		_, _, err := resolveImportSlugs(
			[]classroomAssignmentDetail{det("hw1")}, shortName,
			map[string]string{"hw1": long})
		if err == nil || !strings.Contains(err.Error(), "repo-name limit") {
			t.Fatalf("err = %v, want a repo-name limit error", err)
		}
	})

	t.Run("rename colliding with a verbatim keeper errors", func(t *testing.T) {
		_, _, err := resolveImportSlugs(
			[]classroomAssignmentDetail{det("hw1"), det("hw2")}, shortName,
			map[string]string{"hw1": "hw2"})
		if err == nil || !strings.Contains(err.Error(), "already used") {
			t.Fatalf("err = %v, want a collision error", err)
		}
	})

	t.Run("pattern-invalid slug is left for the skip machinery", func(t *testing.T) {
		out, renames, err := resolveImportSlugs(
			[]classroomAssignmentDetail{det("Bad Slug")}, shortName, nil)
		if err != nil {
			t.Fatalf("resolveImportSlugs: %v", err)
		}
		if out[0].Slug != "Bad Slug" || len(renames) != 0 {
			t.Errorf("got %q (%d renames), want untouched", out[0].Slug, len(renames))
		}
	})
}

// TestParseRenameFlags pins the --rename parsing: well-formed pairs build the
// map; malformed values and duplicate sources error before any network.
func TestParseRenameFlags(t *testing.T) {
	got, err := parseRenameFlags([]string{"a=b", " c = d "})
	if err != nil {
		t.Fatalf("parseRenameFlags: %v", err)
	}
	if got["a"] != "b" || got["c"] != "d" {
		t.Errorf("got %v, want a=b and trimmed c=d", got)
	}
	if _, err := parseRenameFlags([]string{"nope"}); err == nil {
		t.Error("malformed pair must error")
	}
	if _, err := parseRenameFlags([]string{"a="}); err == nil {
		t.Error("empty target must error")
	}
	if _, err := parseRenameFlags([]string{"a=b", "a=c"}); err == nil {
		t.Error("duplicate source must error")
	}
	if got, err := parseRenameFlags(nil); err != nil || got != nil {
		t.Errorf("no flags should be a nil map, got %v (%v)", got, err)
	}
}

func TestAssignmentToEntry(t *testing.T) {
	migratedAt := time.Date(2026, time.May, 25, 20, 21, 0, 0, time.UTC)
	target := assignment.TemplateRef{Owner: "cs50-fall-2026", Repo: "readability", Branch: "main"}

	t.Run("individual happy path matches real export", func(t *testing.T) {
		detail := classroomAssignmentDetail{
			ID:         239897,
			Title:      "readability",
			Slug:       "readability",
			Type:       "individual",
			InviteLink: "https://classroom.github.com/a/9Bxg5uYu",
			Deadline:   nil,
			StarterCodeRepo: &classroomStarterCodeRepo{
				FullName:      "classroom50test/readability",
				DefaultBranch: "main",
				Private:       true,
			},
		}

		entry, err := assignmentToEntry(detail, 95884, target, migratedAt)
		if err != nil {
			t.Fatalf("assignmentToEntry: %v", err)
		}
		if entry.Slug != "readability" || entry.Name != "readability" {
			t.Errorf("slug/name = %q/%q, want readability/readability", entry.Slug, entry.Name)
		}
		if entry.Mode != assignment.ModeIndividual {
			t.Errorf("mode = %q, want %q", entry.Mode, assignment.ModeIndividual)
		}
		if entry.Template == nil || *entry.Template != target {
			t.Errorf("template = %+v, want %+v", entry.Template, target)
		}
		if entry.Due != "" {
			t.Errorf("due = %q, want empty (source deadline was null)", entry.Due)
		}
		if entry.DueMeta != nil {
			t.Errorf("due_meta = %#v, want nil (no deadline)", entry.DueMeta)
		}
		if entry.Autograder != defaultAutograderName {
			t.Errorf("autograder = %q, want %q", entry.Autograder, defaultAutograderName)
		}
		if entry.MigratedFrom == nil {
			t.Fatalf("MigratedFrom is nil")
		}
		if entry.MigratedFrom.Source != migrateSourceGitHubClassroom {
			t.Errorf("migrated_from.source = %q, want %q", entry.MigratedFrom.Source, migrateSourceGitHubClassroom)
		}
		if entry.MigratedFrom.ClassroomID != 95884 || entry.MigratedFrom.AssignmentID != 239897 {
			t.Errorf("migrated_from ids = (%d, %d), want (95884, 239897)", entry.MigratedFrom.ClassroomID, entry.MigratedFrom.AssignmentID)
		}
		if entry.MigratedFrom.StarterRepo != "classroom50test/readability" {
			t.Errorf("migrated_from.starter_repo = %q, want classroom50test/readability", entry.MigratedFrom.StarterRepo)
		}
		if entry.MigratedFrom.InviteLink != "https://classroom.github.com/a/9Bxg5uYu" {
			t.Errorf("migrated_from.invite_link mismatch: %q", entry.MigratedFrom.InviteLink)
		}
		if entry.MigratedFrom.MigratedAt != "2026-05-25T20:21:00Z" {
			t.Errorf("migrated_from.migrated_at = %q, want 2026-05-25T20:21:00Z", entry.MigratedFrom.MigratedAt)
		}
		// What we produce here is what gets committed, so it must
		// pass the write-path validator.
		if err := assignment.ValidateAssignmentEntry(entry); err != nil {
			t.Errorf("assignment.ValidateAssignmentEntry(produced entry): %v", err)
		}
	})

	t.Run("group mode maps max_teams to max_group_size", func(t *testing.T) {
		maxTeams := 4
		detail := classroomAssignmentDetail{
			ID:       1,
			Slug:     "team-project",
			Title:    "Team Project",
			Type:     "group",
			MaxTeams: &maxTeams,
			StarterCodeRepo: &classroomStarterCodeRepo{
				FullName: "src/team-project", DefaultBranch: "main",
			},
		}
		entry, err := assignmentToEntry(detail, 1, target, migratedAt)
		if err != nil {
			t.Fatalf("assignmentToEntry(group): %v", err)
		}
		if entry.Mode != "group" {
			t.Errorf("mode = %q, want %q (preserved losslessly)", entry.Mode, "group")
		}
		if entry.MaxGroupSize != 4 {
			t.Errorf("max_group_size = %d, want 4 (mapped from source max_teams)", entry.MaxGroupSize)
		}
	})

	t.Run("group mode without usable max_teams falls back to the cap", func(t *testing.T) {
		detail := classroomAssignmentDetail{
			ID: 1, Slug: "team-project", Title: "Team Project", Type: "group",
			StarterCodeRepo: &classroomStarterCodeRepo{FullName: "src/team-project", DefaultBranch: "main"},
		}
		entry, err := assignmentToEntry(detail, 1, target, migratedAt)
		if err != nil {
			t.Fatalf("assignmentToEntry(group, no max_teams): %v", err)
		}
		if entry.MaxGroupSize != assignment.MaxGroupSizeCap {
			t.Errorf("max_group_size = %d, want the cap %d as fallback", entry.MaxGroupSize, assignment.MaxGroupSizeCap)
		}
	})

	t.Run("valid RFC-3339 deadline normalizes to UTC with provenance", func(t *testing.T) {
		deadline := "2026-09-15T23:59:00-04:00"
		detail := classroomAssignmentDetail{
			ID: 1, Slug: "ok", Title: "Ok", Type: "individual",
			Deadline:        &deadline,
			StarterCodeRepo: &classroomStarterCodeRepo{FullName: "x/x", DefaultBranch: "main"},
		}
		entry, err := assignmentToEntry(detail, 1, target, migratedAt)
		if err != nil {
			t.Fatalf("assignmentToEntry: %v", err)
		}
		if entry.Due != "2026-09-16T03:59:00Z" {
			t.Errorf("due = %q, want 2026-09-16T03:59:00Z (UTC-normalized)", entry.Due)
		}
		wantMeta := &assignment.DueMeta{Input: deadline, Offset: "-04:00", Source: assignment.DueSourceMigrated}
		if !reflect.DeepEqual(entry.DueMeta, wantMeta) {
			t.Errorf("due_meta = %#v, want %#v", entry.DueMeta, wantMeta)
		}
	})

	t.Run("malformed deadline drops silently", func(t *testing.T) {
		// `due` is advisory; an unparseable value is dropped rather
		// than aborting the migration.
		deadline := "not-a-timestamp"
		detail := classroomAssignmentDetail{
			ID: 1, Slug: "ok", Title: "Ok", Type: "individual",
			Deadline:        &deadline,
			StarterCodeRepo: &classroomStarterCodeRepo{FullName: "x/x", DefaultBranch: "main"},
		}
		entry, err := assignmentToEntry(detail, 1, target, migratedAt)
		if err != nil {
			t.Fatalf("assignmentToEntry: %v", err)
		}
		if entry.Due != "" {
			t.Errorf("due = %q, want empty (malformed deadline dropped)", entry.Due)
		}
		if entry.DueMeta != nil {
			t.Errorf("due_meta = %#v, want nil (malformed deadline dropped)", entry.DueMeta)
		}
	})

	t.Run("zone-less deadline is dropped, not guessed as UTC", func(t *testing.T) {
		// A source deadline without an offset has no knowable zone;
		// interpreting it as UTC would silently shift it, so it's
		// dropped (like the old RFC-3339 reject).
		deadline := "2026-09-15T23:59:00"
		detail := classroomAssignmentDetail{
			ID: 1, Slug: "ok", Title: "Ok", Type: "individual",
			Deadline:        &deadline,
			StarterCodeRepo: &classroomStarterCodeRepo{FullName: "x/x", DefaultBranch: "main"},
		}
		entry, err := assignmentToEntry(detail, 1, target, migratedAt)
		if err != nil {
			t.Fatalf("assignmentToEntry: %v", err)
		}
		if entry.Due != "" {
			t.Errorf("due = %q, want empty (zone-less deadline dropped)", entry.Due)
		}
		if entry.DueMeta != nil {
			t.Errorf("due_meta = %#v, want nil", entry.DueMeta)
		}
	})

	t.Run("missing starter_code_repository still produces an entry", func(t *testing.T) {
		// The skip decision lives at the caller; the helper just
		// records what it has (migrated_from.starter_repo empty).
		detail := classroomAssignmentDetail{
			ID: 1, Slug: "stub", Title: "Stub", Type: "individual",
		}
		entry, err := assignmentToEntry(detail, 1, target, migratedAt)
		if err != nil {
			t.Fatalf("assignmentToEntry: %v", err)
		}
		if entry.MigratedFrom == nil || entry.MigratedFrom.StarterRepo != "" {
			t.Errorf("migrated_from.starter_repo = %q, want empty", entry.MigratedFrom.StarterRepo)
		}
	})

	t.Run("rejects empty slug", func(t *testing.T) {
		_, err := assignmentToEntry(classroomAssignmentDetail{ID: 1, Type: "individual"}, 1, target, migratedAt)
		if err == nil {
			t.Fatalf("expected error for empty slug")
		}
		if !strings.Contains(err.Error(), "empty slug") {
			t.Errorf("err = %v, want 'empty slug' substring", err)
		}
	})

	t.Run("rejects unknown type", func(t *testing.T) {
		_, err := assignmentToEntry(classroomAssignmentDetail{ID: 1, Slug: "valid-slug", Type: "weird"}, 1, target, migratedAt)
		if err == nil {
			t.Fatalf("expected error for unknown type")
		}
		if !strings.Contains(err.Error(), "unknown type") {
			t.Errorf("err = %v, want 'unknown type' substring", err)
		}
	})

	t.Run("rejects slug failing shortNamePattern", func(t *testing.T) {
		// GitHub Classroom permits shapes our shortNamePattern
		// rejects (uppercase, underscores); surface explicitly.
		_, err := assignmentToEntry(classroomAssignmentDetail{ID: 1, Slug: "Hello", Type: "individual"}, 1, target, migratedAt)
		if err == nil {
			t.Fatalf("expected error for capitalized slug")
		}
		if !strings.Contains(err.Error(), "slug") {
			t.Errorf("err = %v, want 'slug' substring", err)
		}
	})
}

// TestClassroomMigratedFromFromDetail pins the classroom-level
// migrated_from shape against real-export data.
func TestClassroomMigratedFromFromDetail(t *testing.T) {
	detail := classroomDetail{
		ID:       95884,
		Name:     "classroom50test",
		Archived: false,
		URL:      "https://classroom.github.com/classrooms/90273123-classroom50test",
		Organization: classroomDetailOrganization{
			Login: "classroom50test",
		},
	}
	migratedAt := time.Date(2026, time.May, 25, 20, 21, 0, 0, time.UTC)

	got := classroomMigratedFromFromDetail(detail, migratedAt)
	if got == nil {
		t.Fatalf("classroomMigratedFromFromDetail returned nil")
		return
	}
	want := configrepo.MigratedFromRef{
		Source:           migrateSourceGitHubClassroom,
		ClassroomID:      95884,
		OriginalName:     "classroom50test",
		OriginalOrgLogin: "classroom50test",
		URL:              "https://classroom.github.com/classrooms/90273123-classroom50test",
		MigratedAt:       "2026-05-25T20:21:00Z",
	}
	if *got != want {
		t.Errorf("classroomMigratedFromFromDetail = %+v, want %+v", *got, want)
	}
}

func TestMigrationPlanCountsByMode(t *testing.T) {
	plan := migrationPlan{
		Assignments: []classroomAssignmentDetail{
			{Type: "individual"},
			{Type: "individual"},
			{Type: "group"},
			{Type: "weird"},
		},
	}
	ind, grp, oth := plan.countsByMode()
	if ind != 2 || grp != 1 || oth != 1 {
		t.Errorf("countsByMode = (%d, %d, %d), want (2, 1, 1)", ind, grp, oth)
	}
}
