package main

import (
	"bufio"
	"embed"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"sort"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/gittree"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// skeletonFS holds the files committed by `gh teacher init`. The
// source tree uses `dotgithub/` because `//go:embed` (without `all:`)
// skips dot-prefixed paths; rewritten to `.github/` at commit time.
//
//go:embed skeleton
var skeletonFS embed.FS

// skeletonProbePath detects "already committed" on re-runs.
// publish-pages.yaml is unique to the config repo; README.md isn't reliable
// (auto_init creates one).
const skeletonProbePath = ".github/workflows/publish-pages.yaml"

// defaultBranchPlaceholder is substituted at commit time so
// publish-pages.yaml listens on the org's actual default branch.
const defaultBranchPlaceholder = "{{DEFAULT_BRANCH}}"

// skeletonFiles returns destination-path → content. Strips the
// `skeleton/` prefix, rewrites `dotgithub/` → `.github/`, and
// substitutes {{DEFAULT_BRANCH}}.
func skeletonFiles(defaultBranch string) (map[string]string, error) {
	files := make(map[string]string)
	walkErr := fs.WalkDir(skeletonFS, "skeleton", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			// __pycache__ isn't dot-prefixed, so //go:embed walks it; don't
			// commit bytecode into config repos.
			if d.Name() == "__pycache__" {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(p, ".pyc") {
			return nil
		}
		data, readErr := skeletonFS.ReadFile(p)
		if readErr != nil {
			return readErr
		}
		rel := strings.TrimPrefix(p, "skeleton/")
		rel = strings.Replace(rel, "dotgithub/", ".github/", 1)
		content := strings.ReplaceAll(string(data), defaultBranchPlaceholder, defaultBranch)
		files[rel] = content
		return nil
	})
	if walkErr != nil {
		return nil, fmt.Errorf("walk skeleton: %w", walkErr)
	}
	if _, ok := files[skeletonProbePath]; !ok {
		return nil, fmt.Errorf("skeleton missing probe file %s (embed misconfigured)", skeletonProbePath)
	}
	return files, nil
}

// skeletonCommitMessage is the single bootstrap commit's message.
var skeletonCommitMessage = contract.PrefixCommit("Bootstrap classroom50 config repo (gh teacher init)")

// skeletonCommitAttempts: read-parent + build-tree retries at 200ms×2^n backoff
// (~3s) to ride out a fresh repo's git-data lag.
const skeletonCommitAttempts = 5

// errRefNotReady: refAndTree returned 200 but an empty SHA — the ref isn't
// readable yet and the Tree API would 404 on the blank base_tree. Retryable.
var errRefNotReady = errors.New("branch ref not fully propagated")

// commitSkeleton lands the embedded skeleton on defaultBranch in one Tree
// commit. When the probe shows a skeleton already landed, it refreshes stale
// files instead (diff, confirm, commit changed paths) so re-running init picks
// up skeleton updates.
//
// A just-created repo serves the git-data APIs before its ref propagates (reads
// 404, the Tree write 409s "Git Repository is empty"), so wait for the tip to
// settle then retry. Both run on every path — "already exists" is often a
// seconds-old repo.
func commitSkeleton(client githubapi.Client, in io.Reader, out, errOut io.Writer, owner, repo, defaultBranch string, assumeYes bool) error {
	files, err := skeletonFiles(defaultBranch)
	if err != nil {
		return err
	}

	probe, err := configrepo.ContentsExists(client, owner, repo, skeletonProbePath, defaultBranch)
	if err != nil {
		return err
	}
	if probe {
		return refreshSkeleton(client, in, out, errOut, owner, repo, defaultBranch, files, assumeYes)
	}

	// Let auto_init's commit propagate first. Best-effort: the retry still
	// covers a ref slow past the poll budget.
	if err := githubapi.WaitForStableBranch(client, owner, repo, defaultBranch); err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: %s/%s: %s slow to propagate (%v); proceeding with retries\n",
			owner, repo, defaultBranch, err)
	}

	// Blobs are content-addressed, so upload once; a retry reuses these SHAs.
	entries, err := githubapi.UploadBlobs(client, owner, repo, files)
	if err != nil {
		return err
	}

	if _, err := githubapi.CommitWithFreshRepoRetry(client, owner, repo, defaultBranch, skeletonCommitMessage, entries, skeletonFreshRepoRetry()); err != nil {
		return err
	}

	_, _ = fmt.Fprintf(out, "%s/%s: skeleton committed (%d files)\n", owner, repo, len(entries))
	return nil
}

// refreshSkeleton brings an already-bootstrapped config repo's skeleton up to
// date: diff embedded vs repo, confirm (skeleton files are user-editable, so an
// overwrite resets customizations), then commit only the stale paths. Declining
// is not an error.
func refreshSkeleton(client githubapi.Client, in io.Reader, out, errOut io.Writer, owner, repo, branch string, files map[string]string, assumeYes bool) error {
	stale, err := diffSkeleton(client, owner, repo, branch, files)
	if err != nil {
		return err
	}
	if len(stale) == 0 {
		_, _ = fmt.Fprintf(out, "%s/%s: skeleton up to date\n", owner, repo)
		return nil
	}

	_, _ = fmt.Fprintf(errOut, "%s/%s: %d skeleton file(s) differ from this CLI's embedded version:\n", owner, repo, len(stale))
	for _, p := range stale {
		_, _ = fmt.Fprintf(errOut, "  %s\n", p)
	}
	if !assumeYes {
		ok, err := confirmSkeletonRefresh(in, errOut)
		if err != nil {
			return err
		}
		if !ok {
			_, _ = fmt.Fprintf(out, "%s/%s: skeleton refresh declined, files left untouched (re-run with --yes to skip the prompt)\n", owner, repo)
			return nil
		}
	}

	// Re-diff inside the build closure so a rebase retry sees each attempt's
	// parent and never re-commits a current file. refreshed resets per attempt
	// so the message reports what actually landed.
	var refreshed int
	build := func(parentSHA string) (map[string]string, error) {
		refreshed = 0
		changed, err := diffSkeleton(client, owner, repo, parentSHA, files)
		if err != nil {
			return nil, err
		}
		updates := make(map[string]string, len(changed))
		for _, p := range changed {
			updates[p] = files[p]
		}
		refreshed = len(changed)
		return updates, nil
	}
	commitSHA, err := configwrite.CommitTree(client, owner, repo, branch, contract.PrefixCommit("Refresh classroom50 skeleton (gh teacher init)"), build)
	if err != nil {
		return err
	}
	if commitSHA == "" {
		// A concurrent writer refreshed the same files between the diff and
		// the commit; nothing left to land.
		_, _ = fmt.Fprintf(out, "%s/%s: skeleton already refreshed by a concurrent writer, nothing to commit\n", owner, repo)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s: skeleton refreshed (%d file(s))\n", owner, repo, refreshed)
	return nil
}

// diffSkeleton returns the sorted skeleton paths whose repo content at
// `ref` is missing or differs from the embedded version.
func diffSkeleton(client githubapi.Client, owner, repo, ref string, files map[string]string) ([]string, error) {
	var stale []string
	for path, want := range files {
		got, exists, err := configrepo.ReadFileContents(client, owner, repo, path, ref)
		if err != nil {
			return nil, fmt.Errorf("read %s/%s/%s: %w", owner, repo, path, err)
		}
		if !exists || string(got) != want {
			stale = append(stale, path)
		}
	}
	sort.Strings(stale)
	return stale, nil
}

// confirmSkeletonRefresh prompts on errOut and reads one line from in.
// Only an explicit y/yes proceeds.
func confirmSkeletonRefresh(in io.Reader, errOut io.Writer) (bool, error) {
	_, _ = fmt.Fprint(errOut, "Overwrite them with the embedded versions? Local customizations to these files will be reset. [y/N]: ")
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return false, fmt.Errorf("read confirmation: %w", err)
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes", nil
}

// skeletonFreshRepoRetry configures the shared fresh-repo-retry loop: ride out
// a fresh repo's git-data lag but treat a missing-`workflow`-scope 404 as
// terminal. createTree's base_tree must resolve, so the retry wraps the write.
func skeletonFreshRepoRetry() gittree.FreshRepoRetry {
	return gittree.FreshRepoRetry{
		Attempts: skeletonCommitAttempts,
		ValidateParent: func(parentSHA, parentTreeSHA string) error {
			if parentSHA == "" || parentTreeSHA == "" {
				return errRefNotReady
			}
			return nil
		},
		Classify404: configwrite.ClassifyWorkflowScope404,
		IsRetryable: isSkeletonRetryable,
	}
}

// isSkeletonRetryable: transient fresh-repo conditions worth a retry — 404
// (reads), 409 "Git Repository is empty" (writes), or an empty parent SHA.
func isSkeletonRetryable(err error) bool {
	if errors.Is(err, configwrite.ErrMissingWorkflowScope) {
		return false
	}
	return cliutil.IsHTTPStatus(err, http.StatusNotFound) ||
		cliutil.IsHTTPStatus(err, http.StatusConflict) ||
		errors.Is(err, errRefNotReady)
}
