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
	"strings"
	"text/template"

	"github.com/spf13/cobra"
)

//go:embed templates/*
var templates embed.FS

// Shells lists the supported shells in help order. PowerShell is absent: gh's
// completer there is one anonymous script block with no function to wrap,
// so a script could only replace it, not chain with another extension's.
var Shells = []string{"bash", "zsh", "fish"}

var templateFile = map[string]string{
	"bash": "templates/bash.sh",
	"zsh":  "templates/zsh.sh",
	"fish": "templates/fish.fish",
}

// Script renders the completion script for shell and the extension invoked
// as `gh <extension>`.
func Script(shell, extension string) (string, error) {
	file, ok := templateFile[shell]
	if !ok {
		return "", fmt.Errorf("unsupported shell %q (supported: %s)", shell, strings.Join(Shells, ", "))
	}
	if !validExtension(extension) {
		return "", fmt.Errorf("invalid extension name %q", extension)
	}
	tmpl, err := template.ParseFS(templates, file)
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
			"them, so the script wraps gh's own completion and routes\n" +
			"`" + invocation + " ...` requests to this extension. Set up gh's completion\n" +
			"first: run `gh completion --help`.\n\n" +
			"Supported shells: " + strings.Join(Shells, ", ") + ".",
	}
	cmd.AddCommand(
		shellCmd(extension, "bash",
			"Add this to ~/.bashrc (or ~/.bash_profile on macOS), after\n"+
				"bash-completion is loaded:\n\n"+
				"  eval \"$("+invocation+" completion bash)\"\n\n"+
				"Then start a new shell.",
		),
		shellCmd(extension, "zsh",
			"Add this to ~/.zshrc, after compinit:\n\n"+
				"  eval \"$("+invocation+" completion zsh)\"\n\n"+
				"Then start a new shell.",
		),
		shellCmd(extension, "fish",
			"Write the script to fish's startup directory:\n\n"+
				"  "+invocation+" completion fish > ~/.config/fish/conf.d/gh-"+extension+".fish\n\n"+
				"Then start a new shell.",
		),
	)
	return cmd
}

func shellCmd(extension, shell, long string) *cobra.Command {
	return &cobra.Command{
		Use:   shell,
		Short: "Generate the completion script for " + shell,
		Long:  "Generate the " + shell + " completion script for `gh " + extension + "`.\n\n" + long,
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			script, err := Script(shell, extension)
			if err != nil {
				return err
			}
			_, err = fmt.Fprint(cmd.OutOrStdout(), script)
			return err
		},
	}
}
