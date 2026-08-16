package auth

import (
	"errors"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/ghauth"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

func NewLoginCmd() *cobra.Command {
	var scopes []string

	cmd := &cobra.Command{
		Use:   "login",
		Short: "Log in to GitHub with the scopes gh-teacher needs",
		Long: "Wrapper around `gh auth login` that requests the unified\n" +
			"Classroom 50 scope set on top of the gh defaults:\n" +
			"admin:org, read:org, repo, and workflow. gh-teacher and\n" +
			"gh-student request the same set so a single sign-in covers\n" +
			"both CLIs. admin:org is required by GitHub's org-membership\n" +
			"endpoints (`gh teacher invite`), and workflow lets `gh teacher\n" +
			"init` commit the classroom50 repository's `.github/workflows/` files\n" +
			"(GitHub 404s that Git Data API write without it).\n\n" +
			"delete_repo is NOT requested by default — opt in with\n" +
			"`gh teacher login -s delete_repo` for `gh teacher teardown`.\n\n" +
			"Additional scopes can be added with -s; they are appended to the\n" +
			"login request the same way `gh auth login -s` accepts them.",
		Example: "  gh teacher login\n" +
			"  gh teacher login -s read:user\n" +
			"  gh teacher login -s read:user,delete_repo",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			if !isInteractiveTTY() {
				return errors.New("gh teacher login requires an interactive terminal (it shells out to gh auth login, which opens a browser)")
			}
			return ghauth.RunLogin(cmd.OutOrStdout(), cmd.ErrOrStderr(),
				ghauth.DefaultHost(), githubapi.RequiredScopes(), scopes)
		},
	}

	cmd.Flags().StringSliceVarP(&scopes, "scopes", "s", nil, "Additional scopes to request (repeatable, or comma-separated)")

	return cmd
}
