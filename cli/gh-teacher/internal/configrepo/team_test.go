package configrepo

import "testing"

func TestClassroomTeamName(t *testing.T) {
	cases := []struct {
		short string
		want  string
	}{
		{"cs-principles", "classroom50-cs-principles"},
		{"intro-java", "classroom50-intro-java"},
		{"cs50", "classroom50-cs50"},
	}
	for _, tc := range cases {
		if got := classroomTeamName(tc.short); got != tc.want {
			t.Errorf("classroomTeamName(%q) = %q, want %q", tc.short, got, tc.want)
		}
		// The slug mirrors the name (already lowercase + hyphens).
		if got := classroomTeamSlug(tc.short); got != tc.want {
			t.Errorf("classroomTeamSlug(%q) = %q, want %q", tc.short, got, tc.want)
		}
	}
}

func TestCanonicalTeamSlugShortName(t *testing.T) {
	cases := []struct {
		short string
		want  bool
	}{
		{"cs-principles", true},
		{"intro-java", true},
		{"cs50", true},
		{"a-b-c", true},
		{"cs--principles", false}, // consecutive hyphens collapse in the slug
		{"foo-", false},           // trailing hyphen trimmed in the slug
		{"a--", false},
	}
	for _, tc := range cases {
		if got := CanonicalTeamSlugShortName(tc.short); got != tc.want {
			t.Errorf("CanonicalTeamSlugShortName(%q) = %v, want %v", tc.short, got, tc.want)
		}
	}
}

// TestRefForRole covers the role->ref mapping the eager grant loops rely on:
// the legacy instructor alias resolves to the teacher ref, each canonical role
// returns its own ref, an unknown role returns nil, and a nil receiver is safe.
func TestRefForRole(t *testing.T) {
	teacher := &TeamRef{ID: 1, Slug: "classroom50-cs50-teacher"}
	hta := &TeamRef{ID: 2, Slug: "classroom50-cs50-hta"}
	ta := &TeamRef{ID: 3, Slug: "classroom50-cs50-ta"}
	refs := &StaffTeamsRef{Teacher: teacher, HeadTA: hta, TA: ta}

	cases := []struct {
		name string
		refs *StaffTeamsRef
		role StaffRole
		want *TeamRef
	}{
		{"teacher", refs, RoleTeacher, teacher},
		{"instructor alias -> teacher", refs, RoleInstructor, teacher},
		{"hta", refs, RoleHeadTA, hta},
		{"ta", refs, RoleTA, ta},
		{"unknown role -> nil", refs, StaffRole("bogus"), nil},
		{"nil receiver -> nil", nil, RoleTeacher, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.refs.RefForRole(tc.role); got != tc.want {
				t.Errorf("RefForRole(%q) = %v, want %v", tc.role, got, tc.want)
			}
		})
	}
}
