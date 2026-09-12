package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	// Embed the IANA tz database so LoadLocation (due-date timezone detection)
	// works on hosts without system zoneinfo — else a named $TZ silently falls
	// back to time.Local and deadlines normalize to the wrong instant.
	_ "time/tzdata"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"golang.org/x/term"

	"github.com/foundation50/gh-teacher/internal/assignmentcmd"
	"github.com/foundation50/gh-teacher/internal/audit"
	"github.com/foundation50/gh-teacher/internal/auth"
	"github.com/foundation50/gh-teacher/internal/classroom"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/download"
	"github.com/foundation50/gh-teacher/internal/invite"
	"github.com/foundation50/gh-teacher/internal/member"
	"github.com/foundation50/gh-teacher/internal/remove"
	"github.com/foundation50/gh-teacher/internal/roster"
	"github.com/foundation50/gh-teacher/internal/servicetoken"
	"github.com/foundation50/gh-teacher/internal/staff"
	"github.com/foundation50/gh-teacher/internal/teamcmd"
	"github.com/foundation50/gh-teacher/internal/teardown"
)

// Build metadata, injected by the release workflow via
// -ldflags "-X main.version=… -X main.commit=… -X main.date=…". Defaults
// identify a local (non-release) build.
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"

	// verbose enables per-step operational output across subcommands.
	verbose bool
)

// flagUsagesWidth caps the Flags section's wrap width on a very wide terminal.
const flagUsagesWidth = 100

// wrappedFlagUsages wraps a flag section to the terminal width, falling back
// to flagUsagesWidth off a terminal. pflag's FlagUsages() wraps at 0 (no
// wrap): every description prints as one unbroken line. That's the real
// cause of the unreadable Flags section (issue #948), not just its length.
// Registered as a template func so helpTemplate can call it on .LocalFlags
// and .InheritedFlags.
func wrappedFlagUsages(fs *pflag.FlagSet) string {
	width, _, err := term.GetSize(int(os.Stdout.Fd()))
	if err != nil || width <= 0 || width > flagUsagesWidth {
		width = flagUsagesWidth
	}
	return fs.FlagUsagesWrapped(width)
}

// usageTemplate is what prints on a usage error: wrong arg count, unknown
// flag, unknown subcommand. Bare invocation with no args hits this too,
// since Cobra validates Args before RunE runs. Kept to a one-line usage plus
// a pointer to --help, instead of Cobra's stock UsageTemplate, which also
// dumps the full Flags section here (issue #948 asks for concise-by-default,
// full text only on an explicit --help).
const usageTemplate = `Usage:{{if .Runnable}}
  {{.UseLine}}{{end}}{{if .HasAvailableSubCommands}}
  {{.CommandPath}} [command]{{end}}{{if .HasAvailableSubCommands}}

Available Commands:{{range .Commands}}{{if (or .IsAvailableCommand (eq .Name "help"))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{end}}{{end}}

Run '{{.CommandPath}} --help' for details and examples.
`

// helpTemplate puts Usage and Examples ahead of the long-form description and
// the Flags dump. Cobra's stock order is description, then Usage/Examples,
// then Flags; a command with many flags (assignment add has 19) runs past
// 100 lines, so Usage/Examples scrolls out of view on a normal terminal
// (issue #948). Same content as Cobra's default templates, just reordered.
const helpTemplate = `Usage:{{if .Runnable}}
  {{.UseLine}}{{end}}{{if .HasAvailableSubCommands}}
  {{.CommandPath}} [command]{{end}}{{if gt (len .Aliases) 0}}

Aliases:
  {{.NameAndAliases}}{{end}}{{if .HasExample}}

Examples:
{{.Example}}{{end}}
{{with (or .Long .Short)}}
{{. | trimTrailingWhitespaces}}
{{end}}{{if .HasAvailableSubCommands}}{{$cmds := .Commands}}{{if eq (len .Groups) 0}}

Available Commands:{{range $cmds}}{{if (or .IsAvailableCommand (eq .Name "help"))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{end}}{{else}}{{range $group := .Groups}}

{{.Title}}{{range $cmds}}{{if (and (eq .GroupID $group.ID) (or .IsAvailableCommand (eq .Name "help")))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{end}}{{end}}{{if not .AllChildCommandsHaveGroup}}

Additional Commands:{{range $cmds}}{{if (and (eq .GroupID "") (or .IsAvailableCommand (eq .Name "help")))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{end}}{{end}}{{end}}{{end}}{{if .HasAvailableLocalFlags}}

Flags:
{{wrappedFlagUsages .LocalFlags | trimTrailingWhitespaces}}{{end}}{{if .HasAvailableInheritedFlags}}

Global Flags:
{{wrappedFlagUsages .InheritedFlags | trimTrailingWhitespaces}}{{end}}{{if .HasHelpSubCommands}}

Additional help topics:{{range .Commands}}{{if .IsAdditionalHelpTopicCommand}}
  {{rpad .CommandPath .CommandPathPadding}} {{.Short}}{{end}}{{end}}{{end}}{{if .HasAvailableSubCommands}}

Use "{{.CommandPath}} [command] --help" for more information about a command.{{end}}
`

func main() {
	root := &cobra.Command{
		Use:     "gh-teacher",
		Short:   "Manage Classroom 50 classrooms, rosters, and assignments",
		Version: versionString(),
	}
	root.SetErrPrefix("gh-teacher:")
	root.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "Show operational details (per-step API/git output)")
	cobra.AddTemplateFunc("wrappedFlagUsages", wrappedFlagUsages)
	root.SetHelpTemplate(helpTemplate)
	root.SetUsageTemplate(usageTemplate)

	root.AddCommand(auth.NewWhoamiCmd())
	root.AddCommand(auth.NewLoginCmd())
	root.AddCommand(auth.NewLogoutCmd())
	root.AddCommand(initCmd())
	root.AddCommand(audit.NewCmd())
	root.AddCommand(servicetoken.NewRotateCmd())
	root.AddCommand(classroom.NewCmd())
	root.AddCommand(roster.NewCmd())
	root.AddCommand(staff.NewCmd())
	root.AddCommand(assignmentcmd.NewCmd())
	root.AddCommand(teamcmd.NewCmd())
	root.AddCommand(autograderCmd())
	root.AddCommand(invite.NewCmd())
	root.AddCommand(remove.NewCmd())
	root.AddCommand(member.NewCmd())
	root.AddCommand(download.NewCmd())
	root.AddCommand(teardown.NewCmd())

	// Signal-aware root context: subcommands see cmd.Context() cancel on
	// Ctrl-C / SIGTERM so in-flight HTTP unwinds.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Most failures exit 1; a command that reports STATE through its exit code
	// (`roster sync`'s 0/1/2 contract) rides out on a cliutil.ExitCodeError.
	if err := root.ExecuteContext(ctx); err != nil {
		os.Exit(cliutil.ExitCodeFor(err))
	}
}

// versionString renders cobra's --version line. A release build shows the
// injected tag, short commit, and build date; a local build stays terse ("dev").
func versionString() string {
	if commit == "none" && date == "unknown" {
		return version
	}
	return fmt.Sprintf("%s (commit %s, built %s)", version, commit, date)
}
