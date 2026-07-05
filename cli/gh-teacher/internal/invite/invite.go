// Package invite implements the `gh teacher invite` command: inviting a GitHub
// user to an organization (direct_member or admin) or to a specific repository
// (with a permission level). Only NewCmd is exported.
package invite

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/membership"
)

var repoPermissions = []string{"pull", "triage", "push", "maintain", "admin"}

func NewCmd() *cobra.Command {
	var (
		admin      bool
		permission string
		quiet      bool
	)

	cmd := &cobra.Command{
		Use:   "invite <org>[/<repo>] <username>",
		Short: "Invite a user to an organization or repository",
		Long: "Invite a GitHub user to an organization or to a specific repository.\n\n" +
			"Forms:\n" +
			"  gh teacher invite <org> <username>                         # invite to organization (direct_member)\n" +
			"  gh teacher invite --admin <org> <username>                 # invite to organization as admin\n" +
			"  gh teacher invite <org>/<repo> <username>                  # invite to repository (push permission)\n" +
			"  gh teacher invite -p maintain <org>/<repo> <username>      # invite to repository as maintainer\n\n" +
			"Repository invitations are idempotent: re-running with a different --permission\n" +
			"updates the existing collaborator. Organization invitations are not: GitHub\n" +
			"rejects re-invites to a pending or existing member.",
		Example: "  gh teacher invite cs50-fall-2026 alice\n" +
			"  gh teacher invite --admin cs50-fall-2026 alice\n" +
			"  gh teacher invite cs50-fall-2026/hello alice\n" +
			"  gh teacher invite -p maintain cs50-fall-2026/hello alice",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			target := strings.TrimSpace(args[0])
			username := strings.TrimSpace(args[1])
			if target == "" {
				return errors.New("target must not be empty")
			}
			if username == "" {
				return errors.New("username must not be empty")
			}

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}

			out := cmd.OutOrStdout()
			errOut := cmd.ErrOrStderr()

			if strings.Contains(target, "/") {
				if admin {
					return errors.New("--admin is only valid for organization invitations")
				}
				if !validRepoPermission(permission) {
					return fmt.Errorf("invalid --permission %q: expected one of %s", permission, strings.Join(repoPermissions, ", "))
				}
				parts := strings.SplitN(target, "/", 3)
				if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
					return fmt.Errorf("invalid target %q: expected ORG or ORG/REPO", target)
				}
				return inviteToRepo(client, out, parts[0], parts[1], username, permission, quiet)
			}

			if cmd.Flags().Changed("permission") {
				return errors.New("--permission is only valid for repository invitations")
			}
			role := "direct_member"
			if admin {
				role = "admin"
			}
			return inviteToOrg(client, out, errOut, target, username, role, quiet)
		},
	}

	cmd.Flags().BoolVar(&admin, "admin", false, "Invite as organization admin (org targets only)")
	cmd.Flags().StringVarP(&permission, "permission", "p", "push", "Repository permission: pull, triage, push, maintain, admin (repo targets only)")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Suppress success output (errors still go to stderr)")

	return cmd
}

func validRepoPermission(p string) bool {
	for _, allowed := range repoPermissions {
		if p == allowed {
			return true
		}
	}
	return false
}

func inviteToOrg(client githubapi.Client, out, errOut io.Writer, org, username, role string, quiet bool) error {
	_, userID, err := membership.LookupUser(client, username)
	if err != nil {
		return err
	}
	if err := membership.InviteOrgByID(client, org, username, userID, role); err != nil {
		return err
	}
	if !quiet {
		_, _ = fmt.Fprintf(out, "%s: invited %s as %s\n", org, username, role)
		_, _ = fmt.Fprintf(errOut, "Advise %s to sign in to https://github.com as %s, then visit https://github.com/%s to accept the invitation at the top of the page.\n", username, username, org)
	}
	return nil
}

func inviteToRepo(client githubapi.Client, out io.Writer, owner, repo, username, permission string, quiet bool) error {
	status, err := githubapi.SetCollaborator(client, owner, repo, username, permission)
	if err != nil {
		return err
	}

	var msg string
	switch status {
	case http.StatusCreated:
		msg = fmt.Sprintf("%s/%s: invited %s with %s permission (awaiting acceptance)\n", owner, repo, username, permission)
	case http.StatusNoContent:
		msg = fmt.Sprintf("%s/%s: added %s with %s permission\n", owner, repo, username, permission)
	}
	if !quiet {
		_, _ = fmt.Fprint(out, msg)
	}
	return nil
}
