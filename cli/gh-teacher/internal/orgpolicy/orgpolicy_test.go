package orgpolicy

import (
	"strings"
	"testing"
)

func TestMemberDefaultSettings_PlanFilter(t *testing.T) {
	enterpriseOnlyFields := map[string]bool{
		"members_can_create_public_repositories":   true,
		"members_can_create_internal_repositories": true,
		"members_can_view_dependency_insights":     true,
		"members_can_invite_outside_collaborators": true,
	}

	// Enterprise gets the full canonical set, including the
	// enterprise-only fields.
	ent := MemberDefaultSettings("enterprise")
	full := allMemberDefaultSettings()
	if len(ent) != len(full) {
		t.Errorf("enterprise plan should get all %d settings, got %d", len(full), len(ent))
	}
	entHas := map[string]bool{}
	for _, s := range ent {
		entHas[s.Field] = true
	}
	for f := range enterpriseOnlyFields {
		if !entHas[f] {
			t.Errorf("enterprise plan should include enterprise-only field %s", f)
		}
	}

	// Team/Free/unknown plans must exclude the enterprise-only fields
	// (Team doesn't expose those toggles).
	for _, plan := range []string{"team", "free", ""} {
		got := MemberDefaultSettings(plan)
		if len(got) != len(full)-len(enterpriseOnlyFields) {
			t.Errorf("plan %q should drop %d enterprise-only settings; got %d of %d", plan, len(enterpriseOnlyFields), len(got), len(full))
		}
		for _, s := range got {
			if enterpriseOnlyFields[s.Field] {
				t.Errorf("plan %q must not include enterprise-only field %s", plan, s.Field)
			}
		}
	}
}

func TestClassifyDefaults_EnforcedAndCriticalMiss(t *testing.T) {
	// Start from a fully-enforced Team baseline, then flip one critical
	// field so the classification flags it and reports criticalMissed.
	live := map[string]any{}
	for _, s := range MemberDefaultSettings("team") {
		live[s.Field] = s.Value
	}

	verdicts, criticalMissed := ClassifyDefaults(live, "team")
	if criticalMissed {
		t.Errorf("a fully-enforced baseline must not report a critical miss")
	}
	if len(verdicts) != len(MemberDefaultSettings("team")) {
		t.Errorf("verdicts = %d, want one per in-scope setting (%d)", len(verdicts), len(MemberDefaultSettings("team")))
	}
	for _, v := range verdicts {
		if !v.Enforced {
			t.Errorf("baseline field %s should classify as enforced", v.Setting.Field)
		}
	}

	// Re-open a critical lockdown field.
	const drifted = "members_can_delete_repositories"
	live[drifted] = true
	verdicts, criticalMissed = ClassifyDefaults(live, "team")
	if !criticalMissed {
		t.Errorf("a drifted critical field (%s) must report criticalMissed", drifted)
	}
	var found bool
	for _, v := range verdicts {
		if v.Setting.Field == drifted {
			found = true
			if v.Enforced {
				t.Errorf("%s drifted to an un-locked value; should classify as unenforced", drifted)
			}
			if !v.Setting.Critical {
				t.Errorf("%s is a critical lockdown field", drifted)
			}
		}
	}
	if !found {
		t.Errorf("classification should include the drifted field %s", drifted)
	}
}

func TestClassifyDefaults_PlanScopesEnterpriseFields(t *testing.T) {
	// An enterprise-only field set to a non-locked value must be ignored
	// on Team (out of scope), so the lockdown stays complete.
	live := map[string]any{}
	for _, s := range MemberDefaultSettings("team") {
		live[s.Field] = s.Value
	}
	live["members_can_view_dependency_insights"] = true // enterprise-only

	verdicts, criticalMissed := ClassifyDefaults(live, "team")
	if criticalMissed {
		t.Errorf("an out-of-scope enterprise-only field must not trigger a critical miss on Team")
	}
	for _, v := range verdicts {
		if v.Setting.Field == "members_can_view_dependency_insights" {
			t.Errorf("enterprise-only field must not appear in a Team-plan classification")
		}
	}
}

func TestClassifyDefaults_NonCriticalDriftIsNotAMiss(t *testing.T) {
	// A drifted in-scope ENABLING field (non-critical) must classify as
	// unenforced but must NOT trip criticalMissed: a teacher who tightened
	// Pages creation is a harmless deviation, not a lockdown safety gap.
	// This pins the `s.Critical` guard in the miss gate — dropping it would
	// silently turn every benign drift into a reported lockdown failure.
	live := map[string]any{}
	for _, s := range MemberDefaultSettings("team") {
		live[s.Field] = s.Value
	}
	const drifted = "members_can_create_public_pages" // enabled (true), non-critical, in scope on team
	live[drifted] = false

	verdicts, criticalMissed := ClassifyDefaults(live, "team")
	if criticalMissed {
		t.Errorf("a drifted non-critical field (%s) must not report criticalMissed", drifted)
	}
	var found bool
	for _, v := range verdicts {
		if v.Setting.Field == drifted {
			found = true
			if v.Enforced {
				t.Errorf("%s drifted from its desired value; should classify as unenforced", drifted)
			}
			if v.Setting.Critical {
				t.Errorf("%s is an enabling field and must stay non-critical", drifted)
			}
		}
	}
	if !found {
		t.Errorf("classification should include the drifted field %s", drifted)
	}
}

func TestManualHardeningSteps(t *testing.T) {
	steps := ManualHardeningSteps("cs50-fall-2026")
	if len(steps) != 4 {
		t.Fatalf("ManualHardeningSteps = %d steps, want 4", len(steps))
	}
	url := "https://github.com/organizations/cs50-fall-2026/settings/member_privileges"
	// Lists the four web-UI-only settings that init can't PATCH, each
	// pointing at the org member-privileges page.
	var joined string
	for _, s := range steps {
		joined += s.Setting + "\n"
		if s.URL != url {
			t.Errorf("step %q URL = %q, want %q", s.Setting, s.URL, url)
		}
	}
	for _, want := range []string{
		"App access requests",
		"GitHub Apps",
		"Projects base permissions",
		"Branch renames",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("manual hardening steps missing %q:\n%s", want, joined)
		}
	}
	// Each instruction must be verb-first/imperative so the teacher
	// knows the exact action (the verb matches the GitHub control:
	// "Uncheck" for checkboxes, "Set" for dropdowns).
	for _, s := range steps {
		if !strings.HasPrefix(s.Setting, "Uncheck ") && !strings.HasPrefix(s.Setting, "Set ") {
			t.Errorf("manual hardening step should start with an action verb (Uncheck/Set): %q", s.Setting)
		}
	}
}

func TestOrgDefaultBranchRecommendation(t *testing.T) {
	cases := []struct {
		name string
		live map[string]any
		want string
	}{
		{"master recommends switching", map[string]any{"default_repository_branch": "master"}, "master"},
		{"develop recommends switching", map[string]any{"default_repository_branch": "develop"}, "develop"},
		{"main is fine", map[string]any{"default_repository_branch": "main"}, ""},
		{"missing field is fine", map[string]any{}, ""},
		{"empty string is fine", map[string]any{"default_repository_branch": ""}, ""},
		{"non-string is fine", map[string]any{"default_repository_branch": 42}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := OrgDefaultBranchRecommendation(tc.live); got != tc.want {
				t.Errorf("OrgDefaultBranchRecommendation = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestConfigRepoDefaultBranchRecommendation(t *testing.T) {
	cases := []struct {
		name   string
		branch string
		want   string
	}{
		{"master recommends renaming", "master", "master"},
		{"develop recommends renaming", "develop", "develop"},
		{"main is fine", "main", ""},
		{"empty is fine", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ConfigRepoDefaultBranchRecommendation(tc.branch); got != tc.want {
				t.Errorf("ConfigRepoDefaultBranchRecommendation = %q, want %q", got, tc.want)
			}
		})
	}
}
