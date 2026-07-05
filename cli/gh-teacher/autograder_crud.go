package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/output"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// requireClassroomExists errors unless <classroom>/classroom.json is present at
// `branch`. Shared by the autograder commands so a typo surfaces as a clear
// "run classroom add" error instead of an empty listing or phantom directory.
func requireClassroomExists(client githubapi.Client, org, classroom, branch string) error {
	marker := classroom + "/classroom.json"
	exists, err := configrepo.ContentsExists(client, org, configrepo.ConfigRepoName, marker, branch)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("classroom %q not found in %s/%s (no %s) -- run `gh teacher classroom add %s %s` first",
			classroom, org, configrepo.ConfigRepoName, marker, org, classroom)
	}
	return nil
}

// gitBlobSHA computes the git blob object id for `content` — the same 40-hex
// SHA-1 the contents/trees API reports — so `autograder show --json` can
// surface it without a second API call. Formula: sha1("blob <len>\x00" + content).
func gitBlobSHA(content []byte) string {
	h := sha1.New()
	_, _ = fmt.Fprintf(h, "blob %d\x00", len(content))
	_, _ = h.Write(content)
	return hex.EncodeToString(h.Sum(nil))
}

// ---- autograder show -------------------------------------------------

// autograderShowMeta is the `--json` view for `autograder show`: the metadata a
// script needs to decide what's installed without parsing the body.
type autograderShowMeta struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
	IsStub bool   `json:"is_stub"`
	Size   int    `json:"size"`
	SHA    string `json:"sha"`
}

func autograderShowCmd() *cobra.Command {
	var (
		asJSON bool
		quiet  bool
	)
	cmd := &cobra.Command{
		Use:   "show <org> <classroom>",
		Short: "Print the classroom's default autograder.py (or report none)",
		Long: "Print the current default autograder at\n" +
			"<org>/classroom50/<classroom>/autograder.py.\n\n" +
			"Default output writes the file body to stdout -- pipe it to a\n" +
			"file or a pager. A one-line summary (whether it's the shipped\n" +
			"diagnostic stub or a custom autograder, plus its size) goes to\n" +
			"stderr unless --quiet.\n\n" +
			"Pass --json for metadata only -- {path, exists, is_stub, size,\n" +
			"sha} -- without the body, so a script can branch on whether a\n" +
			"real autograder is installed.\n\n" +
			"When the classroom has no default autograder.py, stdout stays\n" +
			"empty and stderr says so; the command still exits 0 (an unset\n" +
			"default is a valid mid-setup state, graded as a vacuous pass).\n" +
			"This is a read-only command; no commit lands on the repo.",
		Example: "  gh teacher autograder show cs50-fall-2026 cs-principles\n" +
			"  gh teacher autograder show cs50-fall-2026 cs-principles --json\n" +
			"  gh teacher autograder show cs50-fall-2026 cs-principles > autograder.py",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org, classroom, err := validate.OrgClassroom(args)
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runAutograderShow(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, classroom, asJSON, quiet)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit metadata {path, exists, is_stub, size, sha} instead of the file body")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Suppress the stderr summary so stdout is the only output stream")
	return cmd
}

// runAutograderShow reads <classroom>/autograder.py and renders it as the raw
// body (default) or a metadata object (--json). A missing file is a clean
// exit-0 "none" state.
func runAutograderShow(client githubapi.Client, out, errOut io.Writer, org, classroom string, asJSON, quiet bool) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}
	if err := requireClassroomExists(client, org, classroom, branch); err != nil {
		return err
	}

	repoPath := classroom + "/" + classroomAutograderFilename
	content, ok, err := configrepo.ReadFileContents(client, org, configrepo.ConfigRepoName, repoPath, branch)
	if err != nil {
		return err
	}
	isStub := ok && bytesEqualStub(content)

	if asJSON {
		meta := autograderShowMeta{Path: repoPath, Exists: ok, IsStub: isStub}
		if ok {
			meta.Size = len(content)
			meta.SHA = gitBlobSHA(content)
		}
		data, err := output.JSONPretty(meta)
		if err != nil {
			return err
		}
		_, _ = out.Write(data)
		return nil
	}

	if !ok {
		if !quiet {
			_, _ = fmt.Fprintf(errOut, "%s/%s/%s: no default autograder set — use `gh teacher autograder set-default %s %s` to install one\n",
				org, configrepo.ConfigRepoName, repoPath, org, classroom)
		}
		return nil
	}

	_, _ = out.Write(content)
	if !quiet {
		kind := "custom autograder"
		if isStub {
			kind = "diagnostic stub"
		}
		_, _ = fmt.Fprintf(errOut, "%s/%s/%s: %s (%d bytes)\n", org, configrepo.ConfigRepoName, repoPath, kind, len(content))
	}
	return nil
}

// bytesEqualStub reports whether content is byte-for-byte the shipped stub.
func bytesEqualStub(content []byte) bool {
	return string(content) == string(diagnosticStub)
}

// ---- autograder list -------------------------------------------------

// autograderListEntry is one immediate child of <classroom>/autograders/. Kind
// is "named-shim" for a `<name>.yaml` shim or "per-assignment" for a `<slug>/`
// override bundle.
type autograderListEntry struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Path string `json:"path"`
}

const (
	autograderKindNamedShim     = "named-shim"
	autograderKindPerAssignment = "per-assignment"
)

func autograderListCmd() *cobra.Command {
	var (
		asJSON bool
		quiet  bool
	)
	cmd := &cobra.Command{
		Use:   "list <org> <classroom>",
		Short: "List named and per-assignment autograders under <classroom>/autograders/",
		Long: "List every entry under\n" +
			"<org>/classroom50/<classroom>/autograders/:\n\n" +
			"  - named shims (`<name>.yaml`) opted into with\n" +
			"    `gh teacher assignment add --autograder <name>`\n" +
			"  - per-assignment override bundles (`<slug>/`, holding a\n" +
			"    hand-written autograder.py for that one assignment)\n\n" +
			"Default output is one entry per line on stdout: named shims as\n" +
			"`<name>.yaml`, override bundles as `<slug>/` (trailing slash).\n" +
			"A one-line `<path>: N autograder(s)` summary goes to stderr\n" +
			"unless --quiet. Pass --json for the full array of\n" +
			"{name, kind, path} objects.\n\n" +
			"The classroom DEFAULT autograder (<classroom>/autograder.py)\n" +
			"is not listed here -- inspect it with `gh teacher autograder\n" +
			"show`. Named shims and per-assignment overrides are authored\n" +
			"via ordinary git operations against the config repo; this\n" +
			"command is read-only and lists what is present.",
		Example: "  gh teacher autograder list cs50-fall-2026 cs-principles\n" +
			"  gh teacher autograder list cs50-fall-2026 cs-principles --json",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org, classroom, err := validate.OrgClassroom(args)
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runAutograderList(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, classroom, asJSON, quiet)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit the full JSON array of {name, kind, path} objects instead of one entry per line")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Suppress the stderr summary so stdout is the only output stream")
	return cmd
}

// runAutograderList enumerates the immediate children of
// <classroom>/autograders/ in one contents-API call. A missing directory (404)
// is a clean empty listing.
func runAutograderList(client githubapi.Client, out, errOut io.Writer, org, classroom string, asJSON, quiet bool) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}
	if err := requireClassroomExists(client, org, classroom, branch); err != nil {
		return err
	}

	dirPath := classroom + "/autograders"
	rawEntries, ok, err := configrepo.ListDirContents(client, org, configrepo.ConfigRepoName, dirPath, branch)
	if err != nil {
		return err
	}

	var entries []autograderListEntry
	if ok {
		for _, e := range rawEntries {
			switch {
			case e.Type == "dir":
				entries = append(entries, autograderListEntry{
					Name: e.Name,
					Kind: autograderKindPerAssignment,
					Path: dirPath + "/" + e.Name,
				})
			case e.Type == "file" && strings.HasSuffix(e.Name, ".yaml"):
				entries = append(entries, autograderListEntry{
					Name: strings.TrimSuffix(e.Name, ".yaml"),
					Kind: autograderKindNamedShim,
					Path: dirPath + "/" + e.Name,
				})
				// Any other file (e.g. a stray README) isn't an autograder
				// artifact; skip.
			}
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })

	if asJSON {
		if entries == nil {
			entries = []autograderListEntry{}
		}
		data, err := output.JSONPretty(entries)
		if err != nil {
			return err
		}
		_, _ = out.Write(data)
	} else {
		for _, e := range entries {
			if e.Kind == autograderKindPerAssignment {
				_, _ = fmt.Fprintln(out, e.Name+"/")
			} else {
				_, _ = fmt.Fprintln(out, e.Name+".yaml")
			}
		}
	}

	if !quiet {
		_, _ = fmt.Fprintln(errOut, summarizeAutograderList(org, classroom, entries))
	}
	return nil
}

// summarizeAutograderList: one-line stderr summary shaped
// `<org>/<repo>/<classroom>/autograders: <message>`.
func summarizeAutograderList(org, classroom string, entries []autograderListEntry) string {
	path := fmt.Sprintf("%s/%s/%s/autograders", org, configrepo.ConfigRepoName, classroom)
	if len(entries) == 0 {
		return fmt.Sprintf("%s: no named or per-assignment autograders — the classroom default (autograder.py) covers every assignment", path)
	}
	var named, perAssignment int
	for _, e := range entries {
		if e.Kind == autograderKindPerAssignment {
			perAssignment++
		} else {
			named++
		}
	}
	return fmt.Sprintf("%s: %d autograder(s) (%d named, %d per-assignment)", path, len(entries), named, perAssignment)
}

// ---- autograder remove -----------------------------------------------

func autograderRemoveCmd() *cobra.Command {
	var skipConfirm bool
	cmd := &cobra.Command{
		Use:   "remove <org> <classroom>",
		Short: "Delete the classroom's default autograder.py",
		Long: "Delete <classroom>/autograder.py from <org>/classroom50 in a\n" +
			"single commit. This is distinct from `set-default` with no\n" +
			"--from, which OVERWRITES the file with the diagnostic stub --\n" +
			"remove deletes it outright.\n\n" +
			"Grading impact: once removed, any assignment in the classroom\n" +
			"that has no per-assignment override\n" +
			"(<classroom>/autograders/<slug>/autograder.py) and no\n" +
			"declarative tests falls back to a vacuous pass (0/0) on the\n" +
			"next submission, until you set a new default. Per-assignment\n" +
			"overrides and named shims are NOT touched.\n\n" +
			"You'll be asked to confirm; pass --yes to skip the prompt\n" +
			"(scripted runs only). Idempotent: removing a classroom that\n" +
			"has no default autograder is a no-op.",
		Example: "  gh teacher autograder remove cs50-fall-2026 cs-principles\n" +
			"  gh teacher autograder remove --yes cs50-fall-2026 cs-principles",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org, classroom, err := validate.OrgClassroom(args)
			if err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return removeClassroomDefaultAutograder(client, cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr(), org, classroom, skipConfirm)
		},
	}
	cmd.Flags().BoolVar(&skipConfirm, "yes", false, "Skip the confirmation prompt (scripted runs only)")
	return cmd
}

// removeClassroomDefaultAutograder deletes <classroom>/autograder.py via
// CommitTreeChange. Existence is re-probed inside the build callback so a
// concurrent delete collapses to a no-op.
func removeClassroomDefaultAutograder(client githubapi.Client, in io.Reader, out, errOut io.Writer, org, classroom string, skipConfirm bool) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}
	if err := requireClassroomExists(client, org, classroom, branch); err != nil {
		return err
	}

	repoPath := classroom + "/" + classroomAutograderFilename

	// Preflight so a no-default classroom short-circuits before the prompt.
	exists, err := configrepo.ContentsExists(client, org, configrepo.ConfigRepoName, repoPath, branch)
	if err != nil {
		return err
	}
	if !exists {
		_, _ = fmt.Fprintf(out, "%s/%s/%s: no default autograder set (nothing to remove)\n", org, configrepo.ConfigRepoName, repoPath)
		return nil
	}

	if !skipConfirm {
		proceed, err := confirmAutograderRemove(in, errOut, classroom)
		if err != nil {
			return err
		}
		if !proceed {
			return errors.New("aborted — default autograder not removed")
		}
	}

	build := func(parentSHA string) (configwrite.CommitChange, error) {
		stillThere, err := configrepo.ContentsExists(client, org, configrepo.ConfigRepoName, repoPath, parentSHA)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		if !stillThere {
			return configwrite.CommitChange{}, nil // a concurrent remove won; no-op
		}
		return configwrite.CommitChange{Deletes: []string{repoPath}}, nil
	}

	message := contract.PrefixCommit(fmt.Sprintf("Remove %s default autograder.py (gh teacher autograder remove)", classroom))
	sha, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build)
	if err != nil {
		return err
	}
	if sha == "" {
		_, _ = fmt.Fprintf(out, "%s/%s/%s: already gone (nothing to remove)\n", org, configrepo.ConfigRepoName, repoPath)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s/%s: removed default autograder\n", org, configrepo.ConfigRepoName, repoPath)
	_, _ = fmt.Fprintf(errOut, "Assignments without a per-assignment autograder now grade as a vacuous pass until you run `gh teacher autograder set-default %s %s`\n", org, classroom)
	return nil
}

// confirmAutograderRemove prompts on errOut and reads one line. Only y/yes
// proceeds; a read error (other than EOF) propagates.
func confirmAutograderRemove(in io.Reader, errOut io.Writer, classroom string) (bool, error) {
	_, _ = fmt.Fprintf(errOut, "Remove the default autograder.py for %s? Assignments without a per-assignment override will grade as a vacuous pass until you set a new one. [y/N]: ", classroom)
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return false, fmt.Errorf("read confirmation: %w", err)
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes", nil
}
