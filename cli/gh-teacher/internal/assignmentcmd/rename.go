package assignmentcmd

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/orgrepos"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// assignmentRenameCmd implements `gh teacher assignment rename`: the ONE-SHOT
// slug rename offered solely to remediate an assignment whose composed
// `<classroom>-<slug>-<username>` repo name can exceed GitHub's 100-character
// limit (#691). It commits the config change first (slug + renamed_from +
// scores re-key + autograder dir move, with the assignment locked for the
// duration), then renames every student repo — marker rewrite before PATCH
// rename, per repo — and restores the lock. Idempotent: a re-run resumes from
// state and heals stragglers.
func assignmentRenameCmd() *cobra.Command {
	var (
		skipConfirm bool
		dryRun      bool
		quiet       bool
	)
	cmd := &cobra.Command{
		Use:   "rename <org> <classroom> <old-slug> <new-slug>",
		Short: "Rename an over-budget assignment slug and its repos (one-shot)",
		Long: "Rename an assignment whose composed student-repo name\n" +
			"`<classroom>-<slug>-<username>` can exceed GitHub's 100-character\n" +
			"limit, renaming every existing student repo to match. Offered only\n" +
			"for that remediation, and only once per assignment: the old slug is\n" +
			"recorded as renamed_from and permanently reserved, because creating\n" +
			"a new repo at a renamed repo's old name would sever the automatic\n" +
			"redirects every student clone relies on.\n\n" +
			"What happens, in order:\n" +
			"  1. One config commit: the slug changes, renamed_from records the\n" +
			"     old slug, the scores.json bucket is re-keyed, a per-assignment\n" +
			"     autograders/<slug>/ directory moves, and the assignment is\n" +
			"     locked so nobody accepts mid-rename.\n" +
			"  2. Each student repo (matched by prefix and verified by its\n" +
			"     .classroom50.yaml marker): the marker's `assignment` field is\n" +
			"     rewritten ([skip ci]), then the repo is renamed. GitHub\n" +
			"     redirects git/web/API traffic from the old name indefinitely,\n" +
			"     so student clones keep working; grading picks up the new slug\n" +
			"     on the next run.\n" +
			"  3. The lock is restored to its pre-rename state.\n\n" +
			"Per-repo failures never abort the batch: they're reported with\n" +
			"fixes, and re-running the same command resumes. Already-renamed\n" +
			"repos are skipped, stragglers are healed. Historical submissions\n" +
			"keep their scores (collection accepts the pre-rename slug embedded\n" +
			"in old result.json payloads via renamed_from).\n\n" +
			"Students only need `git pull` once before their next\n" +
			"`gh student submit` (the local marker must catch up); plain pushes\n" +
			"grade correctly immediately.",
		Example: "  gh teacher assignment rename cs50-fall-2026 cs-principles problem-set-three-with-a-long-name ps3\n" +
			"  gh teacher assignment rename cs50-fall-2026 cs-principles old-slug new-slug --dry-run\n" +
			"  gh teacher assignment rename cs50-fall-2026 cs-principles old-slug new-slug --yes",
		Args: cobra.ExactArgs(4),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			oldSlug := strings.TrimSpace(args[2])
			newSlug := strings.TrimSpace(args[3])
			if org == "" || classroom == "" || oldSlug == "" || newSlug == "" {
				return errors.New("org, classroom, old-slug, and new-slug must all be non-empty")
			}
			if err := validate.ShortName(classroom, "classroom"); err != nil {
				return err
			}
			if err := validate.ShortName(oldSlug, "old-slug"); err != nil {
				return err
			}
			if err := validate.ShortName(newSlug, "new-slug"); err != nil {
				return err
			}
			if strings.EqualFold(oldSlug, newSlug) {
				return errors.New("old-slug and new-slug are the same: nothing to rename")
			}
			if err := validate.ComposedRepoNameBudget(classroom, newSlug); err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runAssignmentRename(client, cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr(), renameParams{
				org: org, classroom: classroom, oldSlug: oldSlug, newSlug: newSlug,
				skipConfirm: skipConfirm, dryRun: dryRun, quiet: quiet,
			})
		},
	}
	cmd.Flags().BoolVar(&skipConfirm, "yes", false, "Skip the typed-confirmation prompt (scripted runs only)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Print the rename plan (config change + per-repo actions) without writing anything")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Suppress informational output (per-repo and summary lines); errors still go to stderr")
	return cmd
}

// renameParams carries runAssignmentRename's inputs so tests can call it
// directly, mirroring submissionModeParams.
type renameParams struct {
	org, classroom, oldSlug, newSlug string
	skipConfirm, dryRun, quiet       bool
}

// repoRenameOutcome is one repo's classified fan-out result.
type repoRenameOutcome int

const (
	// repoRenamed: marker rewritten (or already current) and repo renamed.
	repoRenamed repoRenameOutcome = iota
	// repoMarkerHealed: repo already carried the new name (a prior run's
	// rename landed) and only the marker needed rewriting.
	repoMarkerHealed
	// repoCurrent: repo name and marker already consistent — nothing to do
	// (an idempotent re-run over completed work).
	repoCurrent
	// repoSkippedForeign: the prefix matched but the marker names a different
	// assignment (a sibling slug sharing the prefix) — not ours, untouched.
	repoSkippedForeign
	// repoSkippedNoMarker: no readable marker, so ownership can't be verified;
	// left untouched (the repo was already broken for grading).
	repoSkippedNoMarker
	// repoFailed: transient or permission failure — a re-run retries it.
	repoFailed
)

type repoRenameResult struct {
	repo    string
	newName string
	outcome repoRenameOutcome
	reason  string // set for skipped/failed
}

// runAssignmentRename orchestrates preflight -> confirm -> config commit ->
// per-repo fan-out -> lock restore -> report. Config lands FIRST so a run
// that dies mid-fan-out is resumable purely from state: the manifest already
// records the rename, and a re-run classifies each repo by its current name
// and marker.
func runAssignmentRename(client githubapi.Client, in io.Reader, out, errOut io.Writer, p renameParams) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, p.org)
	if err != nil {
		return err
	}

	// Preflight against the current manifest: fresh rename vs resume.
	preFile, err := loadAssignments(client, p.org, p.classroom, branch)
	if err != nil {
		return err
	}
	resume := false
	prevLocked := false
	if idx, ok := assignment.FindAssignment(preFile.Assignments, p.oldSlug); ok {
		entry := preFile.Assignments[idx]
		if entry.RenamedFrom != "" {
			return fmt.Errorf("assignment %q was already renamed once (from %q); a rename is one-shot, so it can't be renamed again", p.oldSlug, entry.RenamedFrom)
		}
		if _, fits := contract.ComposedRepoNameFits(p.classroom, p.oldSlug); fits {
			return fmt.Errorf("assignment %q fits the composed repo-name budget: rename is offered only to remediate a slug whose `<classroom>-<slug>-<username>` student-repo names can exceed GitHub's %d-character limit", p.oldSlug, contract.GitHubRepoNameMaxLen)
		}
		if assignment.SlugExistsFold(preFile.Assignments, p.newSlug) {
			return fmt.Errorf("slug %q already exists in classroom %q: choose a different new-slug", p.newSlug, p.classroom)
		}
		if current, reserved := assignment.SlugReservedFold(preFile.Assignments, p.newSlug); reserved {
			return fmt.Errorf("slug %q is reserved: it is the pre-rename slug of assignment %q. Choose a different new-slug", p.newSlug, current)
		}
		prevLocked = entry.Locked
	} else if idx, ok := assignment.FindAssignment(preFile.Assignments, p.newSlug); ok &&
		strings.EqualFold(preFile.Assignments[idx].RenamedFrom, p.oldSlug) {
		// The config commit already landed (a prior run died mid-fan-out, or
		// this is a deliberate re-run to heal stragglers).
		resume = true
	} else {
		return fmt.Errorf("assignment %q not found in %s/%s/%s: run `gh teacher assignment list %s %s` to see available slugs",
			p.oldSlug, p.org, configrepo.ConfigRepoName, assignmentsFilePath(p.classroom), p.org, p.classroom)
	}

	// Enumerate candidate repos by prefix over the org list (roster-free, so
	// dropped students' repos are covered). Prefix over-match against a
	// sibling slug is possible ("hw" also prefixes "hw-extra" repos), so the
	// fan-out verifies OWNERSHIP per repo via the marker before touching it.
	names, err := orgrepos.ListNames(client, p.org)
	if err != nil {
		return err
	}
	oldPrefix := contract.AssignmentRepoPrefix(p.classroom, p.oldSlug)
	newPrefix := contract.AssignmentRepoPrefix(p.classroom, p.newSlug)
	var toRename, toHeal []string
	for _, name := range names {
		switch {
		case strings.HasPrefix(name, oldPrefix):
			toRename = append(toRename, name)
		case resume && strings.HasPrefix(name, newPrefix):
			// A prior run may have renamed the repo but died before the
			// marker rewrite landed; classified per repo in the fan-out.
			toHeal = append(toHeal, name)
		}
	}

	if !p.quiet || p.dryRun {
		mode := "rename"
		if resume {
			mode = "resume"
		}
		_, _ = fmt.Fprintf(out, "%s %s/%s: %s %q -> %q: %d repo(s) to rename, %d to re-check\n",
			p.org, configrepo.ConfigRepoName, p.classroom, mode, p.oldSlug, p.newSlug, len(toRename), len(toHeal))
	}
	if p.dryRun {
		for _, repo := range toRename {
			_, _ = fmt.Fprintf(out, "  would rename %s -> %s%s (after rewriting its marker)\n",
				repo, newPrefix, strings.TrimPrefix(repo, oldPrefix))
		}
		for _, repo := range toHeal {
			_, _ = fmt.Fprintf(out, "  would re-check the marker of %s\n", repo)
		}
		_, _ = fmt.Fprintln(errOut, "Dry run complete. No API writes performed.")
		return nil
	}

	// The rename is one-shot and renames every student's repo — make the
	// teacher type the new slug (teardown's typed-confirmation pattern).
	if !p.skipConfirm {
		_, _ = fmt.Fprintf(errOut, "This renames %q to %q and renames %d student repo(s). The old slug is permanently reserved.\nType the new slug to confirm: ", p.oldSlug, p.newSlug, len(toRename))
		line, err := bufio.NewReader(in).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return fmt.Errorf("read confirmation: %w", err)
		}
		if strings.TrimSpace(line) != p.newSlug {
			return errors.New("confirmation did not match the new slug: aborted with nothing written")
		}
	}

	if !resume {
		if err := commitRenameConfig(client, p, branch); err != nil {
			return err
		}
		if !p.quiet {
			_, _ = fmt.Fprintf(out, "%s/%s/%s: renamed %s -> %s (renamed_from recorded, assignment locked during the fan-out)\n",
				p.org, configrepo.ConfigRepoName, assignmentsFilePath(p.classroom), p.oldSlug, p.newSlug)
		}
	}

	// Serial fan-out: GitHub's secondary-rate-limit budget makes a concurrent
	// repo-rename fan-out a liability (mirrors the shim retrofit).
	var results []repoRenameResult
	for _, repo := range toRename {
		results = append(results, renameOneRepo(client, p, repo, oldPrefix, newPrefix, false))
	}
	for _, repo := range toHeal {
		results = append(results, renameOneRepo(client, p, repo, oldPrefix, newPrefix, true))
	}
	failed := 0
	for _, r := range results {
		if r.outcome == repoFailed {
			failed++
		}
	}

	// Restore the lock only when THIS run set it (fresh path, previously
	// unlocked) AND every repo landed: with stragglers still at their old
	// names, an unlocked assignment lets a student accept into a fresh repo
	// at the NEW name, permanently 422-ing the straggler's rename. The lock
	// holds until a re-run heals them. On resume the pre-rename lock state is
	// unknowable, so it is left alone with a note rather than guessed.
	if !resume && !prevLocked {
		if failed > 0 {
			_, _ = fmt.Fprintf(errOut, "Note: %q stays locked while %d repo(s) are unrenamed: an accept now would occupy a new repo name and strand a student's work. Re-run to heal them; the lock is restored when everything lands.\n",
				p.newSlug, failed)
		} else if err := setRenamedEntryLocked(client, p, branch, false); err != nil {
			_, _ = fmt.Fprintf(errOut, "Warning: restoring the lock failed (%v). Unlock manually: gh teacher assignment lock %s %s %s --unlock\n",
				err, p.org, p.classroom, p.newSlug)
		}
	}
	if resume {
		if failed == 0 {
			_, _ = fmt.Fprintf(errOut, "Note: resumed run complete. If the original rename locked %q, unlock it with `gh teacher assignment lock %s %s %s --unlock`.\n",
				p.newSlug, p.org, p.classroom, p.newSlug)
		} else {
			_, _ = fmt.Fprintf(errOut, "Note: %q should stay locked while %d repo(s) are unrenamed. Re-run to heal them before unlocking.\n",
				p.newSlug, failed)
		}
	}

	return summarizeRenameResults(out, errOut, p, results)
}

// commitRenameConfig lands the WHOLE config-side rename as one commit:
// assignments.json (slug + renamed_from + locked), the scores.json bucket
// re-key, and the per-assignment autograders/<old>/ directory move. Atomic on
// purpose — a partial config state (renamed slug but orphaned bucket) would
// silently hide grades. The build re-reads everything per attempt so a rebase
// retry observes the latest parent.
func commitRenameConfig(client githubapi.Client, p renameParams, branch string) error {
	message := contract.PrefixCommit(fmt.Sprintf("assignment: rename %s to %s (gh teacher assignment rename)", p.oldSlug, p.newSlug))
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		change := configwrite.CommitChange{Upserts: map[string]string{}}

		file, err := loadAssignments(client, p.org, p.classroom, parentSHA)
		if err != nil {
			return change, err
		}
		idx, ok := assignment.FindAssignment(file.Assignments, p.oldSlug)
		if !ok {
			return change, fmt.Errorf("assignment %q disappeared from %s during the rename: retry", p.oldSlug, assignmentsFilePath(p.classroom))
		}
		// Re-assert the preflight invariants against this attempt's parent:
		// a concurrent write must lose cleanly, never half-apply.
		if file.Assignments[idx].RenamedFrom != "" {
			return change, fmt.Errorf("assignment %q was renamed concurrently: nothing written", p.oldSlug)
		}
		if assignment.SlugExistsFold(file.Assignments, p.newSlug) {
			return change, fmt.Errorf("slug %q was taken concurrently: nothing written", p.newSlug)
		}
		if current, reserved := assignment.SlugReservedFold(file.Assignments, p.newSlug); reserved {
			return change, fmt.Errorf("slug %q is reserved (pre-rename slug of %q): nothing written", p.newSlug, current)
		}
		file.Assignments[idx].Slug = p.newSlug
		file.Assignments[idx].RenamedFrom = p.oldSlug
		// Lock for the fan-out window: an accept mid-rename would mint a
		// fresh empty repo at the NEW name and 422 the real repo's rename.
		file.Assignments[idx].Locked = true
		encoded, err := assignment.EncodeAssignments(file)
		if err != nil {
			return change, err
		}
		change.Upserts[assignmentsFilePath(p.classroom)] = string(encoded)

		// scores.json bucket re-key (skipped when the old bucket is absent —
		// nothing was ever collected).
		scoresPath := p.classroom + "/scores.json"
		raw, exists, err := configrepo.ReadFileContents(client, p.org, configrepo.ConfigRepoName, scoresPath, parentSHA)
		if err != nil {
			return change, err
		}
		if exists {
			rekeyed, changed, err := rekeyScoresBucket(raw, p.oldSlug, p.newSlug)
			if err != nil {
				return change, fmt.Errorf("%s: %w", scoresPath, err)
			}
			if changed {
				change.Upserts[scoresPath] = string(rekeyed)
			}
		}

		// Move a hand-authored autograders/<old>/ directory, or the runner's
		// bundle URL for the new slug 404s and grading silently falls back.
		oldDir := p.classroom + "/autograders/" + p.oldSlug
		newDir := p.classroom + "/autograders/" + p.newSlug
		paths, err := configrepo.ListSubtreeBlobPaths(client, p.org, configrepo.ConfigRepoName, parentSHA, oldDir)
		if err != nil {
			return change, err
		}
		for _, path := range paths {
			content, exists, err := configrepo.ReadFileContents(client, p.org, configrepo.ConfigRepoName, path, parentSHA)
			if err != nil {
				return change, err
			}
			if !exists {
				return change, fmt.Errorf("%s: listed but unreadable, retry", path)
			}
			change.Upserts[newDir+strings.TrimPrefix(path, oldDir)] = string(content)
			change.Deletes = append(change.Deletes, path)
		}
		return change, nil
	}
	_, err := configwrite.CommitTreeChange(client, p.org, configrepo.ConfigRepoName, branch, message, build)
	return err
}

// rekeyScoresBucket moves assignments[oldSlug] to assignments[newSlug] in a
// scores.json document, preserving every byte of the bucket and any unknown
// top-level keys. No old bucket is a clean no-op; an existing new bucket is an
// error (the preflight uniqueness check makes it unreachable short of a race).
func rekeyScoresBucket(raw []byte, oldSlug, newSlug string) ([]byte, bool, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil, false, fmt.Errorf("parse: %w", err)
	}
	var buckets map[string]json.RawMessage
	if err := json.Unmarshal(top["assignments"], &buckets); err != nil {
		return nil, false, fmt.Errorf("parse assignments: %w", err)
	}
	bucket, ok := buckets[oldSlug]
	if !ok {
		return nil, false, nil
	}
	if _, exists := buckets[newSlug]; exists {
		return nil, false, fmt.Errorf("bucket %q already exists: refusing to overwrite it with the %q bucket", newSlug, oldSlug)
	}
	buckets[newSlug] = bucket
	delete(buckets, oldSlug)
	encodedBuckets, err := json.Marshal(buckets)
	if err != nil {
		return nil, false, err
	}
	top["assignments"] = encodedBuckets
	encoded, err := json.MarshalIndent(top, "", "  ")
	if err != nil {
		return nil, false, err
	}
	return append(encoded, '\n'), true, nil
}

// setRenamedEntryLocked flips the renamed entry's locked flag (the post-fan-out
// restore). Reuses lock.go's CommitTree pattern; a no-op when already there.
func setRenamedEntryLocked(client githubapi.Client, p renameParams, branch string, locked bool) error {
	message := contract.PrefixCommit(fmt.Sprintf("assignment: restore lock state of %s after rename (gh teacher assignment rename)", p.newSlug))
	build := func(parentSHA string) (map[string]string, error) {
		file, err := loadAssignments(client, p.org, p.classroom, parentSHA)
		if err != nil {
			return nil, err
		}
		idx, ok := assignment.FindAssignment(file.Assignments, p.newSlug)
		if !ok {
			return nil, fmt.Errorf("assignment %q disappeared from %s: unlock manually", p.newSlug, assignmentsFilePath(p.classroom))
		}
		if file.Assignments[idx].Locked == locked {
			return nil, nil
		}
		file.Assignments[idx].Locked = locked
		encoded, err := assignment.EncodeAssignments(file)
		if err != nil {
			return nil, err
		}
		return map[string]string{assignmentsFilePath(p.classroom): string(encoded)}, nil
	}
	_, err := configwrite.CommitTree(client, p.org, configrepo.ConfigRepoName, branch, message, build)
	return err
}

// renameOneRepo handles a single candidate repo: verify ownership via the
// marker, rewrite the marker's `assignment` field ([skip ci]), then PATCH the
// repo name. `healing` marks a repo already at the new name (resume path), so
// only the marker is checked/rewritten. Ownership is marker-gated because the
// prefix can over-match a sibling slug — a proper sibling repo carries a
// marker naming ITS slug and is skipped untouched.
//
// Marker before rename, on purpose: the config already carries the new slug,
// so a marker pointing at it grades correctly even while the repo still has
// its old name; the reverse order leaves a window where the runner hard-fails
// the manifest lookup.
func renameOneRepo(client githubapi.Client, p renameParams, repo, oldPrefix, newPrefix string, healing bool) repoRenameResult {
	newName := repo
	if !healing {
		newName = newPrefix + strings.TrimPrefix(repo, oldPrefix)
	}
	res := repoRenameResult{repo: repo, newName: newName}

	branch, notFound, err := studentRepoDefaultBranch(client, p.org, repo)
	if err != nil {
		res.outcome, res.reason = repoFailed, err.Error()
		return res
	}
	if notFound {
		// The org listing said it exists; a 404 now means it was deleted (or
		// renamed) concurrently — nothing to do, a re-run re-classifies.
		res.outcome, res.reason = repoFailed, "repo disappeared during the rename; re-run to re-check"
		return res
	}

	// Rewrite the marker inside a rebase-safe commit build (retrofitShim's
	// pattern: read at the parent SHA so the no-op check is authoritative).
	var foreign, missing string
	build := func(parentSHA string) (map[string]string, error) {
		foreign, missing = "", ""
		raw, exists, err := configrepo.ReadFileContents(client, p.org, repo, contract.MetadataPath, parentSHA)
		if err != nil {
			return nil, err
		}
		if !exists {
			missing = "no " + contract.MetadataPath + ": ownership can't be verified, repo left untouched (re-accept heals the marker, then re-run)"
			return nil, nil
		}
		rewritten, changed, current, err := rewriteMarkerAssignment(raw, p.oldSlug, p.newSlug)
		if err != nil {
			missing = fmt.Sprintf("unparseable %s (%v); repo left untouched", contract.MetadataPath, err)
			return nil, nil
		}
		if current != "" {
			foreign = fmt.Sprintf("marker names assignment %q, a sibling slug sharing the prefix, not %q; left untouched", current, p.oldSlug)
			return nil, nil
		}
		if !changed {
			return nil, nil // marker already carries the new slug
		}
		return map[string]string{contract.MetadataPath: string(rewritten)}, nil
	}
	message := contract.PrefixCommit(fmt.Sprintf("Update assignment slug to %s (gh teacher assignment rename)", p.newSlug)) + "\n\n[skip ci]"
	commitSHA, err := configwrite.CommitTree(client, p.org, repo, branch, message, build)
	if err != nil {
		res.outcome, res.reason = repoFailed, fmt.Sprintf("marker rewrite failed: %v", err)
		return res
	}
	switch {
	case foreign != "":
		res.outcome, res.reason = repoSkippedForeign, foreign
		return res
	case missing != "":
		res.outcome, res.reason = repoSkippedNoMarker, missing
		return res
	}

	if healing {
		if commitSHA == "" {
			// Name and marker already consistent — a completed repo on an
			// idempotent re-run.
			res.outcome = repoCurrent
		} else {
			res.outcome = repoMarkerHealed
		}
		return res
	}
	if err := renameRepoAPI(client, p.org, repo, newName); err != nil {
		res.outcome, res.reason = repoFailed, err.Error()
		return res
	}
	res.outcome = repoRenamed
	return res
}

// rewriteMarkerAssignment rewrites the marker's top-level `assignment` scalar
// from oldSlug to newSlug via a yaml.Node round-trip (comments and key order
// survive). Returns (content, changed, "", nil) on a rewrite; (nil, false,
// "", nil) when already newSlug; (nil, false, otherSlug, nil) when the marker
// belongs to a DIFFERENT assignment; an error for an unparseable document.
func rewriteMarkerAssignment(raw []byte, oldSlug, newSlug string) (content []byte, changed bool, foreignSlug string, err error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, false, "", err
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, false, "", errors.New("top level is not a mapping")
	}
	mapping := doc.Content[0]
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value != "assignment" {
			continue
		}
		value := mapping.Content[i+1]
		switch value.Value {
		case newSlug:
			return nil, false, "", nil
		case oldSlug:
			value.SetString(newSlug)
			var buf bytes.Buffer
			enc := yaml.NewEncoder(&buf)
			enc.SetIndent(2)
			if err := enc.Encode(&doc); err != nil {
				return nil, false, "", err
			}
			if err := enc.Close(); err != nil {
				return nil, false, "", err
			}
			return buf.Bytes(), true, "", nil
		default:
			return nil, false, value.Value, nil
		}
	}
	return nil, false, "", errors.New(`no "assignment" key`)
}

// renameRepoAPI issues the PATCH /repos rename. GitHub leaves permanent
// redirects at the old name, so student clones keep working. Failures carry
// the fix: 403 needs repo admin; 422 usually means a repo already sits at the
// new name (a mid-rename accept, or an unrelated repo).
func renameRepoAPI(client githubapi.Client, org, repo, newName string) error {
	body, err := json.Marshal(map[string]string{"name": newName})
	if err != nil {
		return err
	}
	path := fmt.Sprintf("repos/%s/%s", url.PathEscape(org), url.PathEscape(repo))
	resp, err := client.Request(http.MethodPatch, path, bytes.NewReader(body))
	if err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusForbidden) {
			return fmt.Errorf("rename to %q needs admin on the repo (or org ownership); re-run as an owner: %w", newName, err)
		}
		if cliutil.IsHTTPStatus(err, http.StatusUnprocessableEntity) {
			return fmt.Errorf("rename to %q rejected: a repo may already exist at that name (https://github.com/%s/%s); resolve it and re-run: %w", newName, org, newName, err)
		}
		return fmt.Errorf("PATCH %s: %w", path, err)
	}
	_ = resp.Body.Close()
	return nil
}

// summarizeRenameResults prints per-repo lines plus the tally, returning a
// non-zero-exit error when anything failed (best-effort partial completion)
// with the idempotent re-run hint.
func summarizeRenameResults(out, errOut io.Writer, p renameParams, results []repoRenameResult) error {
	var renamed, healed, current, foreign, noMarker, failed int
	for _, r := range results {
		switch r.outcome {
		case repoRenamed:
			renamed++
			if !p.quiet {
				_, _ = fmt.Fprintf(out, "Renamed %s -> %s\n", r.repo, r.newName)
			}
		case repoMarkerHealed:
			healed++
			if !p.quiet {
				_, _ = fmt.Fprintf(out, "Healed the marker of %s\n", r.repo)
			}
		case repoCurrent:
			current++
		case repoSkippedForeign:
			foreign++
			if !p.quiet {
				_, _ = fmt.Fprintf(out, "Skipped %s: %s\n", r.repo, r.reason)
			}
		case repoSkippedNoMarker:
			noMarker++
			_, _ = fmt.Fprintf(errOut, "Warning: skipped %s: %s\n", r.repo, r.reason)
		case repoFailed:
			failed++
			_, _ = fmt.Fprintf(errOut, "Failed %s: %s\n", r.repo, r.reason)
		}
	}
	if !p.quiet {
		_, _ = fmt.Fprintf(out, "%s/%s: rename summary: %d renamed, %d marker(s) healed, %d already current, %d sibling(s) skipped, %d unverifiable, %d failed\n",
			p.org, p.classroom, renamed, healed, current, foreign, noMarker, failed)
	}
	if failed > 0 {
		return fmt.Errorf("%d repo(s) failed: the rename is idempotent, so fix the causes above and re-run the same command to heal them", failed)
	}
	return nil
}
