// Package ghcompletion gives a gh extension a `completion` command whose
// scripts complete `gh <extension> ...` rather than the binary name.
//
// Cobra's default completion command targets the root's name (gh-student),
// which nobody types: extensions run as `gh student`. gh itself completes
// the names of installed extensions but not what follows them
// (cli/cli#5309), so the scripts here wrap gh's own completer and route
// `gh <extension> ...` requests to the extension's cobra `__complete`
// endpoint. Result handling stays with gh's completer.
package ghcompletion

import (
	"embed"
	"fmt"
	"slices"
	"strings"
	"text/template"

	"github.com/spf13/cobra"
)

//go:embed templates/*
var templates embed.FS

// shell is everything shell-specific: the template at
// templates/<name>.<name>, the subcommand, and its install text. setup is a
// format string taking the invocation (`gh student`) then the extension.
type shell struct{ name, setup string }

// PowerShell is absent: gh's completer there is one anonymous script block
// with no function to wrap, so a script could only replace it, not chain
// with another extension's.
var shells = []shell{
	{"bash", "Needs the bash-completion package (on macOS: brew install\n" +
		"bash-completion@2). Add this to ~/.bashrc (or ~/.bash_profile on\n" +
		"macOS), after bash-completion is loaded:\n\n" +
		"  eval \"$(%[1]s completion bash)\"\n\n" +
		"Then start a new shell."},
	{"zsh", "Add this to ~/.zshrc, after compinit:\n\n" +
		"  eval \"$(%[1]s completion zsh)\"\n\n" +
		"Then start a new shell."},
	{"fish", "Write the script to fish's startup directory:\n\n" +
		"  %[1]s completion fish > ~/.config/fish/conf.d/gh-%[2]s.fish\n\n" +
		"Then start a new shell."},
}

func shellNames() []string {
	names := make([]string, len(shells))
	for i, s := range shells {
		names[i] = s.name
	}
	return names
}

// Script renders the completion script for shell and the extension invoked
// as `gh <extension>`.
func Script(name, extension string) (string, error) {
	if !slices.ContainsFunc(shells, func(s shell) bool { return s.name == name }) {
		return "", fmt.Errorf("unsupported shell %q (supported: %s)", name, strings.Join(shellNames(), ", "))
	}
	if !validExtension(extension) {
		return "", fmt.Errorf("invalid extension name %q", extension)
	}
	tmpl, err := template.ParseFS(templates, "templates/"+name+"."+name)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	err = tmpl.Execute(&b, struct{ Ext, Ident string }{
		Ext:   extension,
		Ident: strings.ReplaceAll(extension, "-", "_"),
	})
	return b.String(), err
}

// validExtension accepts the names gh allows for extensions that can also
// be embedded in shell function names once hyphens become underscores.
func validExtension(name string) bool {
	if name == "" {
		return false
	}
	for i, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '-' && i > 0:
		default:
			return false
		}
	}
	return true
}

// Install replaces cobra's default completion command on root. Call it
// before ghhelp.Install so the unknown-subcommand guard covers the group.
func Install(root *cobra.Command, extension string) {
	root.CompletionOptions.DisableDefaultCmd = true
	root.AddCommand(newCmd(extension))
}

func newCmd(extension string) *cobra.Command {
	invocation := "gh " + extension
	cmd := &cobra.Command{
		Use:   "completion",
		Short: "Generate a shell completion script for " + invocation,
		Long: "Generate a script that makes Tab complete `" + invocation + "` commands\n" +
			"and flags in your shell.\n\n" +
			"gh completes the names of installed extensions but not what follows\n" +
			"them, so the script wraps gh's own completion and hands anything typed\n" +
			"after `" + invocation + "` to this extension. Set up gh's completion\n" +
			"first: run `gh completion --help`.\n\n" +
			"Supported shells: " + strings.Join(shellNames(), ", ") + ".",
	}
	for _, s := range shells {
		cmd.AddCommand(shellCmd(extension, s))
	}
	return cmd
}

func shellCmd(extension string, s shell) *cobra.Command {
	invocation := "gh " + extension
	return &cobra.Command{
		Use:   s.name,
		Short: "Generate the completion script for " + s.name,
		Long: "Generate the " + s.name + " completion script for `" + invocation + "`.\n\n" +
			fmt.Sprintf(s.setup, invocation, extension),
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			script, err := Script(s.name, extension)
			if err != nil {
				return err
			}
			_, err = fmt.Fprint(cmd.OutOrStdout(), script)
			return err
		},
	}
}
