package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/foundation50/gh-student/internal/auth"
	"github.com/foundation50/gh-student/internal/invitecmd"
	"github.com/foundation50/gh-student/internal/submitcmd"
)

// Build metadata, injected by the release workflow via -ldflags. Defaults
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
		Use:     "gh-student",
		Short:   "Student-facing GitHub CLI extension",
		Version: versionString(),
	}
	root.SetErrPrefix("gh-student:")
	root.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "Show operational details (per-step API/git output)")

	root.AddCommand(auth.NewWhoamiCmd())
	root.AddCommand(auth.NewLoginCmd())
	root.AddCommand(auth.NewLogoutCmd())
	root.AddCommand(acceptCmd())
	root.AddCommand(invitecmd.NewCmd())
	root.AddCommand(submitcmd.NewCmd())

	// Signal-aware root context: subcommands see cmd.Context() cancel on
	// Ctrl-C / SIGTERM so in-flight HTTP (the Pages fetches in accept and
	// invite) unwinds promptly.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := root.ExecuteContext(ctx); err != nil {
		os.Exit(1)
	}
}

// versionString renders cobra's --version line: a release build shows the
// injected tag, short commit, and build date; a local build stays "dev".
func versionString() string {
	if commit == "none" && date == "unknown" {
		return version
	}
	return fmt.Sprintf("%s (commit %s, built %s)", version, commit, date)
}
