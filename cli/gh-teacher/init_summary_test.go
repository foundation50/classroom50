package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/orgpolicy"
	"github.com/foundation50/gh-teacher/internal/ui"
)

func TestInitSummary_JSONShape(t *testing.T) {
	s := newInitSummary("cs50")
	s.Plan = "team"
	s.ConfigRepo = repoSummary{Name: "classroom50", URL: "https://github.com/cs50/classroom50", Created: true}
	s.PagesURL = "https://cs50.github.io/classroom50/"
	s.LockdownComplete = true
	s.FeedbackPRReady = true
	s.finalize()

	var buf bytes.Buffer
	if err := s.renderJSON(&buf); err != nil {
		t.Fatalf("renderJSON: %v", err)
	}

	// Round-trips to a map and carries the agent-relevant keys.
	var got map[string]any
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("emitted JSON does not decode: %v\n%s", err, buf.String())
	}
	for _, key := range []string{
		"org", "dry_run", "ready", "plan", "config_repo", "pages_url",
		"lockdown_complete", "lockdown_manual_steps", "feedback_pr_ready",
		"manual_hardening_required", "preflight", "warnings",
	} {
		if _, ok := got[key]; !ok {
			t.Errorf("JSON missing key %q:\n%s", key, buf.String())
		}
	}

	// manual_hardening_required is the manual-hardening contract: an array
	// of {setting, url} objects.
	mh, ok := got["manual_hardening_required"].([]any)
	if !ok || len(mh) != 4 {
		t.Fatalf("manual_hardening_required should be a 4-element array, got %T %v", got["manual_hardening_required"], got["manual_hardening_required"])
	}
	first, _ := mh[0].(map[string]any)
	if _, ok := first["setting"]; !ok {
		t.Errorf("manual hardening item missing 'setting': %v", first)
	}
	if _, ok := first["url"]; !ok {
		t.Errorf("manual hardening item missing 'url': %v", first)
	}

	if got["ready"] != true {
		t.Errorf("ready should be true on a complete run, got %v", got["ready"])
	}
}

func TestInitSummary_EmptySlicesSerializeAsArrays(t *testing.T) {
	// no-omitempty + initialized slices => [] not null, matching the
	// repo's other --json commands.
	s := newInitSummary("cs50")
	var buf bytes.Buffer
	if err := s.renderJSON(&buf); err != nil {
		t.Fatalf("renderJSON: %v", err)
	}
	out := buf.String()
	if strings.Contains(out, "null") {
		t.Errorf("JSON must not contain null for empty slices:\n%s", out)
	}
	if !strings.Contains(out, `"lockdown_manual_steps": []`) {
		t.Errorf("empty lockdown_manual_steps should serialize as []:\n%s", out)
	}
	if !strings.Contains(out, `"warnings": []`) {
		t.Errorf("empty warnings should serialize as []:\n%s", out)
	}
}

func TestInitSummary_IncompleteLockdownNotReady(t *testing.T) {
	s := newInitSummary("enterprise-org")
	s.Plan = "enterprise"
	s.ConfigRepo = repoSummary{Name: "classroom50", URL: "https://github.com/enterprise-org/classroom50"}
	s.LockdownComplete = false
	s.LockdownManualSteps = []orgpolicy.ManualStep{{
		Setting: `uncheck "Allow members to invite outside collaborators to repositories for this organization"`,
		URL:     "https://github.com/organizations/enterprise-org/settings/member_privileges",
	}}
	s.finalize()

	if s.Ready {
		t.Errorf("an incomplete lockdown must make ready=false")
	}

	var buf bytes.Buffer
	_ = s.renderJSON(&buf)
	if !strings.Contains(buf.String(), "lockdown_manual_steps") {
		t.Errorf("manual steps should appear in JSON:\n%s", buf.String())
	}
	if !strings.Contains(buf.String(), "outside collaborators") {
		t.Errorf("the manual-fix instruction should appear in JSON:\n%s", buf.String())
	}
}

func TestInitSummary_RenderHuman_ListsKeyFacts(t *testing.T) {
	s := newInitSummary("cs50")
	s.Plan = "team"
	s.ConfigRepo = repoSummary{Name: "classroom50", URL: "https://github.com/cs50/classroom50", Created: true}
	s.PagesURL = "https://cs50.github.io/classroom50/"
	s.LockdownComplete = true
	s.FeedbackPRReady = true
	s.finalize()

	var buf bytes.Buffer
	s.renderHuman(ui.NewForced(&buf, false))
	out := buf.String()
	for _, want := range []string{
		"cs50: init complete",
		"https://github.com/cs50/classroom50",
		"https://cs50.github.io/classroom50/",
		"feedback PR prerequisites: ready",
		// The API-less hardening steps are always an action item.
		"Action required",
		`[ ] Set "App access requests"`,
		// The next command must be obvious.
		"Next: gh teacher classroom add cs50 <short-name>",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("human report missing %q:\n%s", want, out)
		}
	}
	// A complete lockdown should NOT add a lockdown manual step.
	if strings.Contains(out, "delete or transfer repositories") {
		t.Errorf("a complete lockdown should not list lockdown manual steps:\n%s", out)
	}
}

func TestInitSummary_RenderHuman_IncompleteListsActions(t *testing.T) {
	s := newInitSummary("ent")
	s.Plan = "enterprise"
	s.ConfigRepo = repoSummary{URL: "https://github.com/ent/classroom50"}
	s.LockdownComplete = false
	s.LockdownManualSteps = []orgpolicy.ManualStep{{
		Setting: `uncheck "Allow members to delete or transfer repositories for this organization"`,
		URL:     "https://github.com/organizations/ent/settings/member_privileges",
	}}
	s.finalize()

	var buf bytes.Buffer
	s.renderHuman(ui.NewForced(&buf, false))
	out := buf.String()
	// Assert on the banner line specifically: a bare "incomplete" also matches
	// the always-rendered feedback-PR checklist item.
	if !strings.Contains(out, "init incomplete, action needed") {
		t.Errorf("incomplete run should banner incomplete:\n%s", out)
	}
	// The lockdown manual fix is merged into the action checklist as a
	// checkbox, ahead of the always-manual hardening steps.
	if !strings.Contains(out, `[ ] uncheck "Allow members to delete or transfer repositories`) {
		t.Errorf("incomplete lockdown should list the manual fix as a checkbox:\n%s", out)
	}
	// The plan-aware reason is shown so the teacher understands why.
	if !strings.Contains(out, "enterprise") {
		t.Errorf("incomplete lockdown should explain the plan-aware cause:\n%s", out)
	}
	if !strings.Contains(out, "settings/member_privileges") {
		t.Errorf("incomplete lockdown should link the settings page:\n%s", out)
	}
}
