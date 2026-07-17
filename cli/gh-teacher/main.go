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

	"github.com/foundation50/gh-teacher/internal/assignmentcmd"
	"github.com/foundation50/gh-teacher/internal/audit"
	"github.com/foundation50/gh-teacher/internal/auth"
	"github.com/foundation50/gh-teacher/internal/classroom"
	"github.com/foundation50/gh-teacher/internal/download"
	"github.com/foundation50/gh-teacher/internal/invite"
	"github.com/foundation50/gh-teacher/internal/member"
	"github.com/foundation50/gh-teacher/internal/remove"
	"github.com/foundation50/gh-teacher/internal/roster"
	"github.com/foundation50/gh-teacher/internal/servicetoken"
	"github.com/foundation50/gh-teacher/internal/staff"
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

func main() {
	root := &cobra.Command{
		Use:     "gh-teacher",
		Short:   "Teacher-facing GitHub CLI extension",
		Version: versionString(),
	}
	root.SetErrPrefix("gh-teacher:")
	root.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "Show operational details (per-step API/git output)")

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

	if err := root.ExecuteContext(ctx); err != nil {
		os.Exit(1)
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
