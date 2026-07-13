// Package submitcmd implements `gh student submit`: snapshot the current
// branch and push it as a new commit on the assignment repo's default branch,
// so the autograde workflow tags and grades the submission. Extracted command
// package; only NewCmd is exported. Consumes the internal/* seams (githubapi,
// classroomcfg, identity, localgit) + the shared ghutil helper, never main.
package submitcmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/ghui"
	"github.com/foundation50/classroom50-cli-shared/ghutil"
	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/classroomcfg"
	"github.com/foundation50/gh-student/internal/githubapi"
	identitypkg "github.com/foundation50/gh-student/internal/identity"
	"github.com/foundation50/gh-student/internal/ignorematch"
	"github.com/foundation50/gh-student/internal/localgit"
	"github.com/foundation50/gh-student/internal/ui"
)

func NewCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "submit",
		Short: "Submit the current assignment to its remote",
		Long: "Snapshot the current branch and push it as a new commit on top\n" +
			"of the assignment repo's default branch. The autograde workflow\n" +
			"in the student repo listens for pushes to that branch and (a)\n" +
			"creates its own `submit/<UTC-timestamp>-<short-sha>` tag at the\n" +
			"pushed commit and (b) publishes a scored Release at that tag a\n" +
			"minute or two later.\n\n" +
			"Before snapshotting, the latest instructor `.gitignore` and\n" +
			"`.github/` (both optional) are fetched from the template repo\n" +
			"recorded in `.classroom50.yaml` so any teacher-side updates\n" +
			"flow through. The autograder workflow shim itself is set\n" +
			"once at accept time and never refreshed — runtime, dependency,\n" +
			"and grading-logic changes propagate via the runner workflow\n" +
			"and assignments.json on the teacher's side, both fetched\n" +
			"fresh by the runner on every submission.\n\n" +
			"Functionally equivalent to `git commit -am 'Submit' && git push`,\n" +
			"with the template `.gitignore`/`.github/` refresh as the only\n" +
			"delta.",
		Example: "  gh student submit",
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}

			out := cmd.OutOrStdout()
			errOut := cmd.ErrOrStderr()
			verbose, _ := cmd.Flags().GetBool("verbose")

			return submitAssignment(cmd.Context(), client, verbose, out, errOut)
		},
	}

	return cmd
}

func submitAssignment(ctx context.Context, client githubapi.Client, verbose bool, out io.Writer, errOut io.Writer) error {
	const remote = "origin"

	u := ui.New(errOut)

	root, inside, err := localgit.CurrentGitRoot()
	if err != nil {
		return err
	}
	if !inside {
		return fmt.Errorf("not inside a Git repository")
	}

	config, err := classroomcfg.ReadConfig(filepath.Join(root, classroomcfg.MetadataPath))
	if err != nil {
		return err
	}

	message := contract.PrefixCommit(fmt.Sprintf("Submit %s", config.Assignment))

	// Stamp the commit so a shell without git identity still submits.
	identity, err := identitypkg.Fetch(client)
	if err != nil {
		return fmt.Errorf("resolve git identity: %w", err)
	}

	remoteURL, err := gitOutput(root, "config", "--get", "remote."+remote+".url")
	if err != nil {
		return fmt.Errorf("read remote %q URL: %w", remote, err)
	}
	remoteURL = strings.TrimSpace(remoteURL)

	repoOwner, repoName, err := parseGitHubRemote(remoteURL)
	if err != nil {
		return fmt.Errorf("parse remote URL: %w", err)
	}
	repoHTMLURL := fmt.Sprintf("https://github.com/%s/%s", repoOwner, repoName)

	// Push to the assignment repo's actual default branch (which GitHub, not
	// Classroom 50, may have named `master`) so the autograde shim — which
	// triggers on that branch — fires. A failed lookup is fatal: silently
	// falling back to `main` would push to the wrong branch and skip grading.
	branch, err := resolveRepoDefaultBranch(client, repoOwner, repoName)
	if err != nil {
		return err
	}

	tmpRoot, err := os.MkdirTemp("", "classroom50-submit-*")
	if err != nil {
		return fmt.Errorf("create temp submit area: %w", err)
	}
	defer func() {
		if err := os.RemoveAll(tmpRoot); err != nil {
			u.Warn("remove temp submit area %s: %v", tmpRoot, err)
		}
	}()

	workTree := filepath.Join(tmpRoot, "worktree")
	gitDir := filepath.Join(tmpRoot, "submission.git")

	if err := os.MkdirAll(workTree, 0o755); err != nil {
		return fmt.Errorf("create temporary submission worktree: %w", err)
	}

	if verbose {
		u.Detail("Preparing submission snapshot from %s", root)
	}

	// Resolve allowed_files (best-effort): a fetch failure never blocks
	// submission — the runner enforces authoritatively at grade time.
	allowedFiles := fetchAllowedFiles(ctx, repoOwner, config, u, verbose)

	if err := copySubmittableFiles(root, workTree, allowedFiles, u, verbose); err != nil {
		return err
	}

	if config.Source != nil {
		if verbose {
			u.Detail("Fetching latest instructor .gitignore and .github from %s/%s@%s",
				config.Source.Owner,
				config.Source.Repo,
				config.Source.Branch,
			)
		}

		if err := fetchRepoPath(client, workTree, config.Source.Owner, config.Source.Repo, config.Source.Branch, ".gitignore"); err != nil {
			if !classroomcfg.IsHTTPNotFound(err) {
				return fmt.Errorf("fetch instructor .gitignore: %w", err)
			}
		}
		if err := fetchRepoPath(client, workTree, config.Source.Owner, config.Source.Repo, config.Source.Branch, ".github"); err != nil {
			if !classroomcfg.IsHTTPNotFound(err) {
				return fmt.Errorf("fetch instructor .github: %w", err)
			}
		}
	} else if verbose {
		// Template-less assignment: no source repo to refresh from.
		u.Detail("No template source recorded; skipping instructor .gitignore/.github refresh")
	}

	// The push (clone history + commit + push) is the slowest step, so drive a
	// spinner. Non-verbose: discard git's stdout and buffer its stderr,
	// surfacing the tail only on failure, so its "Cloning into…" chatter
	// doesn't scroll the spinner away. Verbose: stream git directly.
	const pushMsg = "Submitting"
	var (
		pushOut, pushErr = out, errOut
		gitErrBuf        bytes.Buffer
		sp               *ghui.Spinner
	)
	if !verbose {
		pushOut = io.Discard
		pushErr = &gitErrBuf
		sp = u.Spinner(pushMsg)
		sp.Start()
	} else {
		u.Detail("Pushing submission to %s %s", remote, branch)
	}

	sha, err := commitWorkTreeOnRemoteBranch(
		gitDir,
		workTree,
		remoteURL,
		branch,
		message,
		identity,
		pushOut,
		pushErr,
	)
	if err != nil {
		if sp != nil {
			sp.Fail(pushMsg)
		}
		if tail := lastNonEmptyLine(gitErrBuf.String()); tail != "" {
			return fmt.Errorf("%w: %s", err, tail)
		}
		return err
	}
	if sp != nil {
		sp.Stop("Submission pushed")
	}

	// Confirmation on stdout: the assignment's full name (falls back to the
	// slug — see resolveAssignmentName), the local submission time, then a
	// link to the submitted commit.
	displayName := resolveAssignmentName(ctx, repoOwner, config.Classroom, config.Secret, config.Assignment)
	localTime := time.Now().Local().Format("2006-01-02 15:04:05 MST")
	_, _ = fmt.Fprintf(out, "Submitted assignment %q at %s\n", displayName, localTime)
	_, _ = fmt.Fprintf(out, "View your submission at: %s/commit/%s\n", repoHTMLURL, sha)

	return nil
}

// fetchEntryFn resolves the manifest entry; injectable so tests can
// exercise the success and failure paths without a live Pages fetch.
var fetchEntryFn = assignments.FetchEntry

// fetchAllowedFiles resolves the assignment's allowed_files patterns
// from the manifest. Best-effort: any failure returns nil and warns,
// since the runner enforces the list authoritatively. Bounded by
// assignmentNameTimeout.
func fetchAllowedFiles(ctx context.Context, org string, config *classroomcfg.Config, u *ui.UI, verbose bool) []string {
	ctx, cancel := context.WithTimeout(ctx, assignmentNameTimeout)
	defer cancel()
	entry, err := fetchEntryFn(ctx, org, config.Classroom, config.Secret, config.Assignment)
	if err != nil {
		if verbose {
			u.Detail("Could not resolve allowed_files (%v); submitting all files — the autograder enforces the list", err)
		}
		return nil
	}
	if len(entry.AllowedFiles) > 0 && verbose {
		u.Detail("Applying allowed_files filter (%d pattern(s))", len(entry.AllowedFiles))
	}
	return entry.AllowedFiles
}

// resolveAssignmentName returns the assignment's full name from the published
// manifest, falling back to the slug on any error/timeout. The fetch is
// bounded (assignmentNameTimeout) and runs after the push succeeded, so submit
// never fails — or stalls — over cosmetics.
func resolveAssignmentName(ctx context.Context, org, classroom, secret, slug string) string {
	ctx, cancel := context.WithTimeout(ctx, assignmentNameTimeout)
	defer cancel()
	entry, err := assignments.FetchEntry(ctx, org, classroom, secret, slug)
	if err != nil || strings.TrimSpace(entry.Name) == "" {
		return slug
	}
	return entry.Name
}

// assignmentNameTimeout caps the cosmetic post-push name lookup so a slow
// Pages CDN can't stall the terminal after the submission already landed.
const assignmentNameTimeout = 3 * time.Second

// resolveRepoDefaultBranch reads the assignment repo's default branch. A GET
// failure is returned as an error (submitting to the wrong branch would skip
// grading); an empty value falls back to "main" (matches an auto_init repo).
func resolveRepoDefaultBranch(client githubapi.Client, owner, repo string) (string, error) {
	var resp struct {
		DefaultBranch string `json:"default_branch"`
	}
	path := fmt.Sprintf("repos/%s/%s", url.PathEscape(owner), url.PathEscape(repo))
	if err := client.Get(path, &resp); err != nil {
		return "", fmt.Errorf("resolve default branch for %s/%s: %w", owner, repo, err)
	}
	if resp.DefaultBranch == "" {
		return "main", nil
	}
	return resp.DefaultBranch, nil
}

func gitOutput(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir

	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := errors.AsType[*exec.ExitError](err); ok {
			return "", fmt.Errorf("%s: %s", strings.Join(cmd.Args, " "), strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", fmt.Errorf("%s: %w", strings.Join(cmd.Args, " "), err)
	}

	return string(out), nil
}

type contentsEntry struct {
	Type string `json:"type"`
	Name string `json:"name"`
	Path string `json:"path"`
}
type contentsFile struct {
	Type     string `json:"type"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	Encoding string `json:"encoding"`
	Content  string `json:"content"`
}

func fetchRepoPath(
	client githubapi.Client,
	dstRoot string,
	owner string,
	repo string,
	ref string,
	path string,
) error {
	apiPath := fmt.Sprintf("repos/%s/%s/contents/%s?ref=%s",
		url.PathEscape(owner),
		url.PathEscape(repo),
		classroomcfg.EscapeContentPath(path),
		url.QueryEscape(ref),
	)

	var raw json.RawMessage
	if err := client.Get(apiPath, &raw); err != nil {
		return fmt.Errorf("GET %s: %w", apiPath, err)
	}

	trimmed := bytes.TrimSpace(raw)

	if len(trimmed) == 0 {
		return fmt.Errorf("empty contents response for %s", path)
	}

	switch trimmed[0] {
	case '[':
		var entries []contentsEntry
		if err := json.Unmarshal(raw, &entries); err != nil {
			return fmt.Errorf("parse directory response for %s: %w", path, err)
		}

		for _, entry := range entries {
			if entry.Type == "dir" || entry.Type == "file" {
				if err := fetchRepoPath(client, dstRoot, owner, repo, ref, entry.Path); err != nil {
					return err
				}
			}
		}

		return nil
	case '{':
		var file contentsFile
		if err := json.Unmarshal(raw, &file); err != nil {
			return fmt.Errorf("parse file response for %s: %w", path, err)
		}

		if file.Type != "file" {
			return nil
		}

		if file.Encoding != "base64" {
			return fmt.Errorf("unsupported encoding %q for %s", file.Encoding, path)
		}

		decoded, err := ghutil.DecodeContentsBase64(file.Content)
		if err != nil {
			return fmt.Errorf("decode base64 content for %s: %w", path, err)
		}
		dst := filepath.Join(dstRoot, file.Path)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return fmt.Errorf("create parent dir for %s: %w", dst, err)
		}

		if err := os.WriteFile(dst, decoded, 0o644); err != nil {
			return fmt.Errorf("write %s: %w", dst, err)
		}

		return nil
	default:
		return fmt.Errorf("unexpected contents response for %s", path)
	}
}

// parseGitHubRemote extracts (owner, repo) from a GitHub remote URL. Accepts
// SSH (`git@github.com:owner/repo[.git]`), HTTPS
// (`https://github.com/owner/repo[.git]`), and `ssh://git@github.com/...`.
func parseGitHubRemote(remoteURL string) (owner, repo string, err error) {
	remoteURL = strings.TrimSpace(remoteURL)
	remoteURL = strings.TrimSuffix(remoteURL, ".git")
	switch {
	case strings.HasPrefix(remoteURL, "git@github.com:"):
		rest := strings.TrimPrefix(remoteURL, "git@github.com:")
		owner, repo = splitOwnerRepo(rest)
	case strings.HasPrefix(remoteURL, "https://github.com/"):
		rest := strings.TrimPrefix(remoteURL, "https://github.com/")
		owner, repo = splitOwnerRepo(rest)
	case strings.HasPrefix(remoteURL, "ssh://git@github.com/"):
		rest := strings.TrimPrefix(remoteURL, "ssh://git@github.com/")
		owner, repo = splitOwnerRepo(rest)
	default:
		return "", "", fmt.Errorf("unrecognized GitHub remote shape %q (expected git@github.com:owner/repo or https://github.com/owner/repo)", remoteURL)
	}
	if owner == "" || repo == "" {
		return "", "", fmt.Errorf("malformed GitHub remote %q: missing owner or repo", remoteURL)
	}
	return owner, repo, nil
}

// splitOwnerRepo splits "owner/repo[/extra]" on the first slash.
// Empty either side → ("", "").
func splitOwnerRepo(s string) (owner, repo string) {
	parts := strings.SplitN(s, "/", 3)
	if len(parts) < 2 {
		return "", ""
	}
	return parts[0], parts[1]
}

// commitWorkTreeOnRemoteBranch clones origin into a temporary bare repo,
// stages workTree onto `branch`, commits with `identity`, and pushes. Returns
// the new commit SHA (informational; the runner workflow auto-tags on its end).
func commitWorkTreeOnRemoteBranch(gitDir string, workTree string, remoteURL string, branch string, message string, identity identitypkg.GitIdentity, out io.Writer, errOut io.Writer) (string, error) {
	if err := runCmd(out, errOut, "", "git", "clone", "--bare", remoteURL, gitDir); err != nil {
		return "", fmt.Errorf("clone remote history: %w", err)
	}

	git := func(args ...string) error {
		return runGitWithDirAndTree(gitDir, workTree, out, errOut, args...)
	}

	ref := "refs/heads/" + branch

	if err := git("symbolic-ref", "HEAD", ref); err != nil {
		return "", fmt.Errorf("set HEAD to %s: %w", ref, err)
	}

	if err := git("add", "--all"); err != nil {
		return "", fmt.Errorf("stage work tree: %w", err)
	}

	// `-c` scopes identity to this commit; env vars
	// (GIT_AUTHOR_*, GIT_COMMITTER_*) still win.
	if err := git(
		"-c", "user.name="+identity.Name,
		"-c", "user.email="+identity.Email,
		"commit", "--allow-empty", "-m", message,
	); err != nil {
		return "", fmt.Errorf("commit submission: %w", err)
	}

	if err := git("push", "origin", "HEAD:"+ref); err != nil {
		return "", fmt.Errorf("push submission: %w", err)
	}

	// Resolve HEAD post-push so callers can log the SHA the runner will tag.
	sha, err := gitOutputWithGitDir(gitDir, "rev-parse", "HEAD")
	if err != nil {
		return "", fmt.Errorf("resolve submission SHA: %w", err)
	}
	return strings.TrimSpace(sha), nil
}

// gitOutputWithGitDir runs `git --git-dir=<gitDir> <args>`. Separate from
// gitOutput because rev-parsing the submitted commit runs against the bare
// clone (no work tree).
func gitOutputWithGitDir(gitDir string, args ...string) (string, error) {
	fullArgs := append([]string{"--git-dir", gitDir}, args...)
	cmd := exec.Command("git", fullArgs...)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := errors.AsType[*exec.ExitError](err); ok {
			return "", fmt.Errorf("git %v: %s", fullArgs, strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", fmt.Errorf("git %v: %w", fullArgs, err)
	}
	return string(out), nil
}

func runGitWithDirAndTree(
	gitDir string,
	workTree string,
	out io.Writer,
	errOut io.Writer,
	args ...string,
) error {
	fullArgs := []string{"--git-dir", gitDir}
	if workTree != "" {
		fullArgs = append(fullArgs, "--work-tree", workTree)
	}
	fullArgs = append(fullArgs, args...)

	cmd := exec.Command("git", fullArgs...)
	cmd.Stdout = out
	cmd.Stderr = errOut

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git %v: %w", fullArgs, err)
	}

	return nil
}

func runCmd(out io.Writer, errOut io.Writer, dir string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Stdout = out
	cmd.Stderr = errOut

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %v: %w", name, args, err)
	}

	return nil
}

func copySubmittableFiles(srcRoot string, dstRoot string, allowedFiles []string, u *ui.UI, verbose bool) error {
	cmd := exec.Command("git", "ls-files", "-co", "--exclude-standard", "-z")
	cmd.Dir = srcRoot

	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("list submittable files: %w", err)
	}

	entries := bytes.Split(out, []byte{0})

	// Candidate relative paths (skipping .git) for one check-ignore pass.
	var candidates []string
	for _, entry := range entries {
		if len(entry) == 0 {
			continue
		}
		rel := string(entry)
		if rel == ".git" || strings.HasPrefix(rel, ".git/") {
			continue
		}
		candidates = append(candidates, rel)
	}

	disallowed := make(map[string]bool)
	if len(allowedFiles) > 0 {
		var filterable []string
		for _, rel := range candidates {
			if isControlPath(rel) {
				continue
			}
			filterable = append(filterable, rel)
		}
		d, err := ignorematch.Disallowed(allowedFiles, filterable)
		if err != nil {
			// Best-effort: the runner enforces authoritatively.
			if verbose {
				u.Detail("allowed_files filter skipped (%v); submitting all files", err)
			}
		} else {
			disallowed = d
		}
	}

	for _, rel := range candidates {
		if disallowed[rel] {
			if verbose {
				u.Detail("Excluding %s (outside allowed_files)", rel)
			}
			continue
		}

		src := filepath.Join(srcRoot, rel)
		dst := filepath.Join(dstRoot, rel)

		info, err := os.Lstat(src)
		if err != nil {
			return fmt.Errorf("stat %s: %w", src, err)
		}

		if info.IsDir() {
			continue
		}

		if err := copyFilePreservingMode(src, dst, info.Mode()); err != nil {
			return err
		}
	}

	return nil
}

// isControlPath reports whether rel is a control file always submitted
// regardless of allowed_files. Lockstep with runner.py's _is_control_path /
// ALLOWED_FILES_KEEP_*: the .classroom50.yaml marker, the .github/ shim, the
// .git metadata dir, and the runner outputs (result.json, release-body.md).
// Both sides are pinned by cli/shared/testdata/control_path_cases.json.
//
// `.git` is included for literal parity with the Python keep-set even though
// copySubmittableFiles already strips it upstream — keeping the two
// classifiers identical means the lockstep holds without relying on that
// precondition.
func isControlPath(rel string) bool {
	switch rel {
	case classroomcfg.MetadataPath, contract.ResultFilename, contract.ReleaseBodyFilename:
		return true
	case ".github", ".git":
		return true
	}
	return strings.HasPrefix(rel, ".github/") || strings.HasPrefix(rel, ".git/")
}

// lastNonEmptyLine returns the last non-empty trimmed line of s, used to
// surface git's actionable error (e.g. `fatal: ...`) when its stderr was
// buffered rather than streamed.
func lastNonEmptyLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if t := strings.TrimSpace(lines[i]); t != "" {
			return t
		}
	}
	return ""
}

func copyFilePreservingMode(src string, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("create parent dir for %s: %w", dst, err)
	}

	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer func() {
		_ = in.Close()
	}()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}
	defer func() {
		_ = out.Close()
	}()

	if _, err := io.Copy(out, in); err != nil {
		return fmt.Errorf("copy %s to %s: %w", src, dst, err)
	}

	return nil
}
