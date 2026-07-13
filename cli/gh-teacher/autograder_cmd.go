package main

import (
	"bytes"
	_ "embed"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// classroomAutograderFilename: file written under <classroom>/. Mirrored in
// publish-pages.yaml and runner.py's classroom_default_autograder_url.
const classroomAutograderFilename = "autograder.py"

// diagnosticStub is written to <classroom>/autograder.py when `autograder
// set-default` runs without --from. Echoes runner env vars, writes a
// vacuous-pass result.json, exits 0 — for verifying the pipeline before real
// grading logic.
//
//go:embed embed/autograder.py
var diagnosticStub []byte

// autograderCmd: top-level group for classroom default autograders.
// Per-assignment autograders live as files at
// `<classroom>/autograders/<slug>/autograder.py` and are managed via git.
func autograderCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "autograder",
		Short: "Manage the classroom default autograder.py",
		Long: "Manage the default autograder for a classroom. The default\n" +
			"runs for every assignment in the classroom that has no\n" +
			"per-assignment override at\n" +
			"<classroom>/autograders/<slug>/autograder.py — replacing it\n" +
			"lets you grade every assignment in the classroom with one\n" +
			"script (e.g., a slug-driven dispatcher to a third-party\n" +
			"grader).\n\n" +
			"  set-default  install/replace <classroom>/autograder.py\n" +
			"  show         print it (or report none); --json for metadata\n" +
			"  remove       delete it (distinct from the stub overwrite)\n" +
			"  list         list named shims + per-assignment overrides\n\n" +
			"Named shims (<classroom>/autograders/<name>.yaml) and\n" +
			"per-assignment overrides (<classroom>/autograders/<slug>/\n" +
			"autograder.py) are read-only from the CLI — `list` shows what\n" +
			"is present; author or delete them via ordinary git operations\n" +
			"against the config repo.",
	}
	cmd.AddCommand(autograderSetDefaultCmd())
	cmd.AddCommand(autograderShowCmd())
	cmd.AddCommand(autograderListCmd())
	cmd.AddCommand(autograderRemoveCmd())
	return cmd
}

// autograderSetDefaultCmd: replace `<classroom>/autograder.py` with `--from
// <path>` (or stdin via `--from -`). When --from is omitted, writes the
// diagnostic stub. Single Tree commit; no-ops when the body is unchanged.
func autograderSetDefaultCmd() *cobra.Command {
	var fromPath string
	cmd := &cobra.Command{
		Use:   "set-default <org> <classroom>",
		Short: "Replace <classroom>/autograder.py with --from (or the diagnostic stub when omitted)",
		Long: "Replace `<classroom>/autograder.py` in <org>/classroom50\n" +
			"with the contents of --from <path>. Pass `--from -` to\n" +
			"read from stdin (one-shot agent flows). Lands as a single\n" +
			"Tree commit on the config repo's default branch and is\n" +
			"picked up by every subsequent submission once the next\n" +
			"`publish-pages.yaml` run deploys (~30s).\n\n" +
			"When --from is omitted, writes the diagnostic stub shipped\n" +
			"with this CLI — it echoes every env var the runner exposed\n" +
			"and emits a vacuous-pass result.json, so teachers can verify\n" +
			"the runner pipeline before authoring real grading logic.\n\n" +
			"Re-running with the same content is a no-op — the commit\n" +
			"is skipped if the proposed body matches the file already\n" +
			"in the repo.",
		Example: "  gh teacher autograder set-default cs50-fall-2026 cs-principles --from ./autograder.py\n" +
			"  cat my-autograder.py | gh teacher autograder set-default cs50-fall-2026 cs-principles --from -\n" +
			"  gh teacher autograder set-default cs50-fall-2026 cs-principles\n" +
			"  gh teacher autograder set-default cs50-fall-2026 cs-principles \\\n" +
			"      --from examples/autograders/cs50/autograder.py",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			org, classroom, err := validate.OrgClassroom(args)
			if err != nil {
				return err
			}

			content, label, err := readAutograderSource(strings.TrimSpace(fromPath), cmd.InOrStdin())
			if err != nil {
				return err
			}

			client, err := githubapi.DefaultClient()
			if err != nil {
				return fmt.Errorf("REST client: %w", err)
			}

			return setClassroomDefaultAutograder(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, classroom, label, content)
		},
	}
	cmd.Flags().StringVar(&fromPath, "from", "", "Path to the autograder.py to upload, or `-` to read from stdin. Omit to install the shipped diagnostic stub.")
	return cmd
}

// readAutograderSource loads the proposed body. Empty `path` returns the
// embedded stub; `-` reads stdin; any other value is a filesystem path. Empty
// content from --from is rejected — an empty autograder.py would silently
// disable grading for every assignment.
func readAutograderSource(path string, stdin io.Reader) (content []byte, label string, err error) {
	if path == "" {
		return diagnosticStub, "<diagnostic stub>", nil
	}
	if path == "-" {
		content, err = io.ReadAll(stdin)
		label = "<stdin>"
	} else {
		content, err = os.ReadFile(path)
		label = path
	}
	if err != nil {
		return nil, label, fmt.Errorf("read --from %s: %w", label, err)
	}
	if len(bytes.TrimSpace(content)) == 0 {
		return nil, label, fmt.Errorf("--from %s is empty (refusing to upload an empty autograder.py)", label)
	}
	return content, label, nil
}

// setClassroomDefaultAutograder lands `content` as `<classroom>/autograder.py`.
// Validates the classroom exists before writing (prevents typos creating
// phantom files). Skips the commit when the file is already byte-equal.
func setClassroomDefaultAutograder(client githubapi.Client, out, errOut io.Writer, org, classroom, label string, content []byte) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	// Validate the classroom is registered before writing — else a typo'd name
	// silently creates a phantom dir with only autograder.py that never grades
	// (no assignments registered there).
	if err := requireClassroomExists(client, org, classroom, branch); err != nil {
		return err
	}

	repoPath := classroom + "/" + classroomAutograderFilename
	build := func(parentSHA string) (map[string]string, error) {
		existing, err := fetchFileContent(client, org, configrepo.ConfigRepoName, repoPath, parentSHA)
		if err != nil {
			return nil, err
		}
		if existing != nil && bytes.Equal(existing, content) {
			return nil, nil // no-op: identical to the repo
		}
		return map[string]string{repoPath: string(content)}, nil
	}

	message := contract.PrefixCommit(fmt.Sprintf("Set %s default autograder.py from %s (gh teacher autograder set-default)", classroom, label))
	commitSHA, err := configwrite.CommitTree(client, org, configrepo.ConfigRepoName, branch, message, build)
	if err != nil {
		return err
	}
	if commitSHA == "" {
		_, _ = fmt.Fprintf(out, "%s/%s: %s already matches —\u00a0no commit\n", org, configrepo.ConfigRepoName, repoPath)
		return nil
	}

	_, _ = fmt.Fprintf(out, "%s/%s: updated %s (commit %s)\n", org, configrepo.ConfigRepoName, repoPath, commitSHA[:8])
	_, _ = fmt.Fprintf(errOut, "View at https://github.com/%s/%s/blob/%s/%s\n", org, configrepo.ConfigRepoName, branch, repoPath)
	_, _ = fmt.Fprintf(errOut, "Next: wait ~30s for publish-pages.yaml to redeploy, then push a submission to test\n")
	return nil
}

// fetchFileContent returns the raw bytes of `path` at `ref`. 404 → (nil, nil)
// so the caller treats "doesn't exist yet" like "different from proposed".
// Other errors propagate. The contents API base64-encodes files up to ~1 MB;
// autograder.py is well under that.
func fetchFileContent(client githubapi.Client, owner, repo, path, ref string) ([]byte, error) {
	segs := strings.Split(path, "/")
	for i := range segs {
		segs[i] = url.PathEscape(segs[i])
	}
	apiPath := fmt.Sprintf("repos/%s/%s/contents/%s?ref=%s",
		url.PathEscape(owner), url.PathEscape(repo),
		strings.Join(segs, "/"), url.PathEscape(ref))

	var body struct {
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	if err := client.Get(apiPath, &body); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("GET %s: %w", apiPath, err)
	}
	if body.Encoding != "base64" {
		return nil, fmt.Errorf("GET %s: unexpected encoding %q (want base64)", apiPath, body.Encoding)
	}
	// GitHub wraps base64 at 60 chars; strip whitespace before decoding.
	clean := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, body.Content)
	out, err := base64.StdEncoding.DecodeString(clean)
	if err != nil {
		return nil, fmt.Errorf("decode %s contents: %w", apiPath, err)
	}
	return out, nil
}
