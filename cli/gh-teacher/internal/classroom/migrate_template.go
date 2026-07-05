package classroom

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// templateAction classifies what template-copy did for one source assignment.
type templateAction string

const (
	templateActionGenerated templateAction = "generated"
	templateActionReused    templateAction = "reused"
	templateActionSkipped   templateAction = "skipped"
)

// resolvedTemplate is the per-assignment outcome of template copy. Skipped
// entries are omitted from assignments.json; the rest of the migration lands.
type resolvedTemplate struct {
	Assignment classroomAssignmentDetail
	Template   assignment.TemplateRef
	Action     templateAction
	SkipReason string
	// TargetPrivate is the TARGET template repo's visibility (the copy in the
	// org), not the source. The team read-grant gates on this so the Reused
	// branch can't mis-decide when target and source visibility differ.
	TargetPrivate bool
}

// targetRepoProbe classifies the target template repo before generate runs.
// Branch is populated only when Exists.
type targetRepoProbe struct {
	Exists     bool
	IsTemplate bool
	Branch     string
	Private    bool
}

// probeTargetRepo GETs the target repo, returning existence + is_template. 404
// is the safe-to-generate path; any other error propagates.
func probeTargetRepo(client githubapi.Client, owner, repo string) (targetRepoProbe, error) {
	path := fmt.Sprintf("repos/%s/%s", url.PathEscape(owner), url.PathEscape(repo))
	var resp struct {
		IsTemplate    bool   `json:"is_template"`
		DefaultBranch string `json:"default_branch"`
		Private       bool   `json:"private"`
	}
	if err := client.Get(path, &resp); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return targetRepoProbe{Exists: false}, nil
		}
		return targetRepoProbe{}, fmt.Errorf("GET %s: %w", path, err)
	}
	return targetRepoProbe{Exists: true, IsTemplate: resp.IsTemplate, Branch: resp.DefaultBranch, Private: resp.Private}, nil
}

// verifySourceIsTemplate confirms the source starter repo carries
// `is_template: true`. GitHub's generate endpoint requires it.
func verifySourceIsTemplate(client githubapi.Client, owner, repo string) (bool, error) {
	path := fmt.Sprintf("repos/%s/%s", url.PathEscape(owner), url.PathEscape(repo))
	var resp struct {
		IsTemplate bool `json:"is_template"`
	}
	if err := client.Get(path, &resp); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return false, fmt.Errorf("source repo %s/%s not accessible to your account", owner, repo)
		}
		return false, fmt.Errorf("GET %s: %w", path, err)
	}
	return resp.IsTemplate, nil
}

// generateFromTemplate POSTs .../generate to create a new repo from the source
// template, returning the new default branch. `private` is always passed so the
// target inherits the source's privacy.
func generateFromTemplate(client githubapi.Client, srcOwner, srcRepo, targetOwner, targetName, description string, private bool) (string, error) {
	body, err := json.Marshal(struct {
		Owner              string `json:"owner"`
		Name               string `json:"name"`
		Description        string `json:"description,omitempty"`
		IncludeAllBranches bool   `json:"include_all_branches"`
		Private            bool   `json:"private"`
	}{
		Owner:              targetOwner,
		Name:               targetName,
		Description:        description,
		IncludeAllBranches: true,
		Private:            private,
	})
	if err != nil {
		return "", fmt.Errorf("encode generate body: %w", err)
	}

	path := fmt.Sprintf("repos/%s/%s/generate", url.PathEscape(srcOwner), url.PathEscape(srcRepo))
	resp, err := client.Request(http.MethodPost, path, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("POST %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("POST %s: status %d: %s", path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode generate response: %w", err)
	}
	if out.DefaultBranch == "" {
		// Defensive: a missing default_branch would land an unusable
		// TemplateRef on disk.
		return "", fmt.Errorf("POST %s: response missing default_branch", path)
	}
	return out.DefaultBranch, nil
}

// markAsTemplate flips the repo's `is_template` flag via PATCH. `generate`
// always produces a non-template repo, so this makes it usable for `student
// accept`.
func markAsTemplate(client githubapi.Client, owner, repo string) error {
	body, err := json.Marshal(struct {
		IsTemplate bool `json:"is_template"`
	}{IsTemplate: true})
	if err != nil {
		return fmt.Errorf("encode is_template body: %w", err)
	}
	path := fmt.Sprintf("repos/%s/%s", url.PathEscape(owner), url.PathEscape(repo))
	resp, err := client.Request(http.MethodPatch, path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("PATCH %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("PATCH %s: status %d: %s", path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

// targetTemplateName returns the target repo name — slug, optionally with a
// user-supplied suffix to escape collisions.
func targetTemplateName(slug, suffix string) string {
	if suffix == "" {
		return slug
	}
	return slug + "-" + suffix
}

// runTemplateCopy walks every source assignment through validate → probe →
// generate → mark-as-template, in plan order. Best-effort: a per-assignment
// failure becomes a Skipped resolvedTemplate, not a hard error.
func runTemplateCopy(client githubapi.Client, errOut io.Writer, plan migrationPlan, templateSuffix string) ([]resolvedTemplate, error) {
	out := make([]resolvedTemplate, 0, len(plan.Assignments))
	for _, a := range plan.Assignments {
		r, err := copyOneTemplate(client, errOut, plan.TargetOrg, templateSuffix, plan.Classroom.ID, a)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

// copyOneTemplate handles a single source assignment:
//
//   - slug/mode fails downstream validation → skip
//   - source repo missing or not a template → skip
//   - target name 404 → generate + mark + wait for branch to stabilize
//   - target name exists + is_template → reuse
//   - target name exists + !is_template → skip with collision error
//
// Skip reasons are recorded on `errOut`. classroomID comes from the discovery
// context, not `a.Classroom.ID` (unreliable on the assignment-detail response).
func copyOneTemplate(client githubapi.Client, errOut io.Writer, targetOrg, templateSuffix string, classroomID int64, a classroomAssignmentDetail) (resolvedTemplate, error) {
	skip := func(reason string) resolvedTemplate {
		_, _ = fmt.Fprintf(errOut, "Skipping %q: %s\n", a.Slug, reason)
		return resolvedTemplate{Assignment: a, Action: templateActionSkipped, SkipReason: reason}
	}

	// Validate the shape downstream AssignmentEntry needs BEFORE any API writes
	// — otherwise a bad slug/mode generates a template repo, then drops the
	// entry at commit time, orphaning the repo.
	if err := validate.ShortName(a.Slug, "slug"); err != nil {
		return skip(err.Error()), nil
	}
	if !assignment.IsValidAssignmentMode(a.Type) {
		return skip(fmt.Sprintf("source has unknown type %q (must be one of %v)", a.Type, assignment.AssignmentModes)), nil
	}

	if a.StarterCodeRepo == nil || a.StarterCodeRepo.FullName == "" {
		return skip("source has no starter_code_repository"), nil
	}

	srcOwner, srcRepo, err := splitOwnerRepo(a.StarterCodeRepo.FullName)
	if err != nil {
		return skip(err.Error()), nil
	}

	isTemplate, err := verifySourceIsTemplate(client, srcOwner, srcRepo)
	if err != nil {
		return skip(err.Error()), nil
	}
	if !isTemplate {
		return skip(fmt.Sprintf("source repo %s is not a template — flip Settings → \"Template repository\" on the source and re-run", a.StarterCodeRepo.FullName)), nil
	}

	targetName := targetTemplateName(a.Slug, templateSuffix)
	probe, err := probeTargetRepo(client, targetOrg, targetName)
	if err != nil {
		return skip(fmt.Sprintf("probe target %s/%s: %v", targetOrg, targetName, err)), nil
	}

	if probe.Exists {
		if !probe.IsTemplate {
			return skip(fmt.Sprintf("%s/%s already exists and is not a template — pass --template-suffix <s> (renames to %s-<s>) or delete the colliding repo",
				targetOrg, targetName, a.Slug)), nil
		}
		_, _ = fmt.Fprintf(errOut, "Reusing existing template %s/%s for %q.\n", targetOrg, targetName, a.Slug)
		return resolvedTemplate{
			Assignment:    a,
			Action:        templateActionReused,
			Template:      assignment.TemplateRef{Owner: targetOrg, Repo: targetName, Branch: probe.Branch},
			TargetPrivate: probe.Private,
		}, nil
	}

	description := fmt.Sprintf("Migrated from GitHub Classroom (classroom %d, assignment %d)", classroomID, a.ID)
	branch, err := generateFromTemplate(client, srcOwner, srcRepo, targetOrg, targetName, description, a.StarterCodeRepo.Private)
	if err != nil {
		return skip(fmt.Sprintf("generate %s/%s from %s/%s: %v", targetOrg, targetName, srcOwner, srcRepo, err)), nil
	}
	if err := markAsTemplate(client, targetOrg, targetName); err != nil {
		_, _ = fmt.Fprintf(errOut, "Generated %s/%s for %q but PATCH is_template:true failed: %v — fix manually with `gh repo edit %s/%s --template`.\n",
			targetOrg, targetName, a.Slug, err, targetOrg, targetName)
		return resolvedTemplate{Assignment: a, Action: templateActionSkipped, SkipReason: "is_template PATCH failed: " + err.Error()}, nil
	}
	// Wait for the freshly-generated branch ref to propagate before downstream
	// `student accept` runs against it — otherwise students hit transient 409
	// "Git Repository is empty".
	if err := githubapi.WaitForStableBranch(client, targetOrg, targetName, branch); err != nil {
		_, _ = fmt.Fprintf(errOut, "Generated %s/%s for %q but branch %q did not stabilize: %v — students may need to retry `gh student accept` shortly.\n",
			targetOrg, targetName, a.Slug, branch, err)
		// Non-fatal: the repo exists and is a template; the wait was a
		// courtesy. Record as generated so the commit includes the entry.
	}

	return resolvedTemplate{
		Assignment:    a,
		Action:        templateActionGenerated,
		Template:      assignment.TemplateRef{Owner: targetOrg, Repo: targetName, Branch: branch},
		TargetPrivate: a.StarterCodeRepo.Private,
	}, nil
}

// splitOwnerRepo splits a `<owner>/<repo>` full-name. Empty/multi-slash inputs
// are rejected so a malformed source can't mis-route the generate call.
func splitOwnerRepo(fullName string) (owner, repo string, err error) {
	parts := strings.Split(fullName, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("invalid full_name %q: expected <owner>/<repo>", fullName)
	}
	return parts[0], parts[1], nil
}

// countTemplateActions tallies the resolved-template Actions for
// the post-commit summary.
func countTemplateActions(resolved []resolvedTemplate) (generated, reused, skipped int) {
	for _, r := range resolved {
		switch r.Action {
		case templateActionGenerated:
			generated++
		case templateActionReused:
			reused++
		case templateActionSkipped:
			skipped++
		}
	}
	return generated, reused, skipped
}

// countEntriesByMode tallies committed entries' mode. Computed from the entries
// (not the pre-skip plan) so the summary can't disagree with what landed.
func countEntriesByMode(entries []assignment.AssignmentEntry) (individual, group int) {
	for _, e := range entries {
		switch e.Mode {
		case assignment.ModeIndividual:
			individual++
		case assignment.ModeGroup:
			group++
		}
	}
	return individual, group
}
