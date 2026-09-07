package auth

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"
)

func NewLogoutCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "logout",
		Short: "Log out of GitHub",
		Long: "Wrapper around `gh auth logout`. Removes the local gh\n" +
			"authentication, so later commands need a fresh\n" +
			"`gh student login`.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true

			sub := exec.Command("gh", "auth", "logout")
			sub.Stdin = os.Stdin
			sub.Stdout = cmd.OutOrStdout()
			sub.Stderr = cmd.ErrOrStderr()

			if err := sub.Run(); err != nil {
				return fmt.Errorf("gh auth logout: %w", err)
			}
			return nil
		},
	}

	return cmd
}
