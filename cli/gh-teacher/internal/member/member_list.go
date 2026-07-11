// Package member implements the `gh teacher member` command: read-only views of
// actual GitHub membership (org members + pending invitations, or repo
// collaborators) — the counterpart to `invite`/`remove`, used to reconcile the
// intended roster against real membership. Only NewCmd is exported.
package member

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/membership"
	"github.com/foundation50/gh-teacher/internal/output"
)

// memberAPIPerPage / memberPagesMax bound the paginated membership walks.
// 100×100 = 10k, far beyond any classroom org.
const (
	memberAPIPerPage = 100
	memberPagesMax   = 100
)

// memberListEntry is one row of `member list` output. Kind separates the
// surfaces reconciled against the roster (org member, pending invitation, repo
// collaborator). Role is the org role or repo permission level; empty when
// GitHub didn't report it. github_id is 0 for pending invitations (keyed on
// login/email, not id).
type memberListEntry struct {
	Login    string `json:"login"`
	Kind     string `json:"kind"`
	Role     string `json:"role"`
	GitHubID int64  `json:"github_id"`
}

const (
	memberKindOrgMember     = "member"
	memberKindOrgInvitation = "invitation"
	memberKindCollaborator  = "collaborator"
)

func NewCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "member",
		Short: "Inspect organization and repository membership",
		Long: "Read-only views of who is actually a member of an org or a\n" +
			"collaborator on a repo -- the counterpart to `gh teacher\n" +
			"invite` / `gh teacher remove`.\n\n" +
			"The roster (roster.csv) is the INTENDED membership; this\n" +
			"command shows ACTUAL GitHub membership, so the two can be\n" +
			"reconciled when they drift (a student on the roster who never\n" +
			"accepted their invite, or a collaborator added out of band).\n\n" +
			"Subcommands:\n" +
			"  list   list org members + pending invitations, or repo collaborators",
	}
	cmd.AddCommand(memberListCmd())
	return cmd
}

func memberListCmd() *cobra.Command {
	var (
		asJSON bool
		quiet  bool
	)
	cmd := &cobra.Command{
		Use:   "list <org>[/<repo>]",
		Short: "List org members + pending invitations, or repo collaborators",
		Long: "List actual GitHub membership for a target.\n\n" +
			"Forms:\n" +
			"  gh teacher member list <org>         # org members + pending invitations, with role\n" +
			"  gh teacher member list <org>/<repo>  # repo collaborators, with permission level\n\n" +
			"Default output is an aligned table on stdout (login, kind,\n" +
			"role, github_id) with a one-line `<target>: N member(s)`\n" +
			"summary on stderr. Pass --json for the full array of\n" +
			"{login, kind, role, github_id} objects, or --quiet for one\n" +
			"login per line (no table, no stderr summary) -- pipeable into\n" +
			"`xargs`, `grep`, or an agent loop. --json takes precedence.\n\n" +
			"For an org, `kind` is `member` (active) or `invitation`\n" +
			"(pending -- needs the admin:org scope to read). For a repo,\n" +
			"`kind` is `collaborator` and `role` is the permission level\n" +
			"(read/triage/write/maintain/admin). Read-only; no write lands.",
		Example: "  gh teacher member list cs50-fall-2026\n" +
			"  gh teacher member list cs50-fall-2026 --json\n" +
			"  gh teacher member list cs50-fall-2026/hello\n" +
			"  gh teacher member list cs50-fall-2026 --quiet",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			target := strings.TrimSpace(args[0])
			if target == "" {
				return errors.New("target must not be empty")
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			if strings.Contains(target, "/") {
				parts := strings.SplitN(target, "/", 3)
				if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
					return fmt.Errorf("invalid target %q: expected ORG or ORG/REPO", target)
				}
				return runMemberListRepo(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), parts[0], parts[1], asJSON, quiet)
			}
			return runMemberListOrg(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), target, asJSON, quiet)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Emit the full JSON array of {login, kind, role, github_id} objects instead of the table")
	cmd.Flags().BoolVarP(&quiet, "quiet", "q", false, "Print one login per line (no table, no stderr summary)")
	return cmd
}

// runMemberListOrg lists active org members (with role) and pending
// invitations. Active members come from two role-filtered walks since GET
// /orgs/{org}/members doesn't report a per-member role inline. Read-only.
func runMemberListOrg(client githubapi.Client, out, errOut io.Writer, org string, asJSON, quiet bool) error {
	entries, err := collectOrgMembers(client, org)
	if err != nil {
		return err
	}
	invites, err := collectOrgInvitations(client, org)
	if err != nil {
		return err
	}
	entries = append(entries, invites...)
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Kind != entries[j].Kind {
			return entries[i].Kind < entries[j].Kind
		}
		return strings.ToLower(entries[i].Login) < strings.ToLower(entries[j].Login)
	})
	return renderMemberList(out, errOut, org, entries, asJSON, quiet)
}

// collectOrgMembers walks org members for admins then all, labeling roles. The
// admin set drives the role; everyone else is a plain member.
func collectOrgMembers(client githubapi.Client, org string) ([]memberListEntry, error) {
	adminIDs := map[int64]bool{}
	admins, err := paginateMembers(client, fmt.Sprintf("orgs/%s/members?role=admin", url.PathEscape(org)), org+" members")
	if err != nil {
		return nil, err
	}
	for _, a := range admins {
		adminIDs[a.ID] = true
	}
	all, err := paginateMembers(client, fmt.Sprintf("orgs/%s/members", url.PathEscape(org)), org+" members")
	if err != nil {
		return nil, err
	}
	entries := make([]memberListEntry, 0, len(all))
	for _, m := range all {
		role := "member"
		if adminIDs[m.ID] {
			role = "admin"
		}
		entries = append(entries, memberListEntry{
			Login:    m.Login,
			Kind:     memberKindOrgMember,
			Role:     role,
			GitHubID: m.ID,
		})
	}
	return entries, nil
}

// collectOrgInvitations walks pending org invitations. A 403 (no admin:org
// scope) is a clear error rather than silently dropping the set, since "no
// pending invites" and "can't read invites" are very different signals.
func collectOrgInvitations(client githubapi.Client, org string) ([]memberListEntry, error) {
	base := fmt.Sprintf("orgs/%s/invitations", url.PathEscape(org))
	subject := fmt.Sprintf("%s pending invitations", org)
	invites, err := githubapi.PaginateAll[orgInvitation](client, memberAPIPerPage, memberPagesMax,
		func(page int) string {
			return fmt.Sprintf("%s?per_page=%d&page=%d", base, memberAPIPerPage, page)
		},
		func(path string, err error) error { return classifyMembershipReadError(path, subject, err) })
	if err != nil {
		return nil, err
	}
	entries := make([]memberListEntry, 0, len(invites))
	for _, inv := range invites {
		entries = append(entries, memberListEntry{
			Login:    inv.Login,
			Kind:     memberKindOrgInvitation,
			Role:     normalizeInviteRole(inv.Role),
			GitHubID: inv.ID,
		})
	}
	return entries, nil
}

// normalizeInviteRole maps the invitations API's role names onto the same
// vocabulary the members listing uses, so the two org surfaces read
// consistently.
func normalizeInviteRole(role string) string {
	switch role {
	case "direct_member":
		return "member"
	case "":
		return "member"
	default:
		return role
	}
}

// runMemberListRepo lists collaborators on a repo with their
// permission level (role_name). Read-only.
func runMemberListRepo(client githubapi.Client, out, errOut io.Writer, owner, repo string, asJSON, quiet bool) error {
	base := fmt.Sprintf("repos/%s/%s/collaborators", url.PathEscape(owner), url.PathEscape(repo))
	subject := owner + "/" + repo
	collabs, err := githubapi.PaginateAll[repoCollaborator](client, memberAPIPerPage, memberPagesMax,
		func(page int) string {
			return fmt.Sprintf("%s?per_page=%d&page=%d", base, memberAPIPerPage, page)
		},
		func(path string, err error) error { return classifyMembershipReadError(path, subject, err) })
	if err != nil {
		return err
	}
	entries := make([]memberListEntry, 0, len(collabs))
	for _, c := range collabs {
		entries = append(entries, memberListEntry{
			Login:    c.Login,
			Kind:     memberKindCollaborator,
			Role:     c.RoleName, // raw permission level; "" → "-" in the table
			GitHubID: c.ID,
		})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return strings.ToLower(entries[i].Login) < strings.ToLower(entries[j].Login)
	})
	return renderMemberList(out, errOut, subject, entries, asJSON, quiet)
}

// memberAccount is the shared shape of a GET .../members element.
type memberAccount struct {
	Login string `json:"login"`
	ID    int64  `json:"id"`
}

// orgInvitation is one GET /orgs/{org}/invitations element.
type orgInvitation struct {
	Login string `json:"login"`
	ID    int64  `json:"id"`
	Role  string `json:"role"`
}

// repoCollaborator is one GET /repos/{o}/{r}/collaborators element.
type repoCollaborator struct {
	Login    string `json:"login"`
	ID       int64  `json:"id"`
	RoleName string `json:"role_name"`
}

// paginateMembers walks a members listing endpoint with the shared cap. `base`
// already carries any role filter; `subject` is a human label for errors.
func paginateMembers(client githubapi.Client, base, subject string) ([]memberAccount, error) {
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	return githubapi.PaginateAll[memberAccount](client, memberAPIPerPage, memberPagesMax,
		func(page int) string {
			return fmt.Sprintf("%s%sper_page=%d&page=%d", base, sep, memberAPIPerPage, page)
		},
		func(path string, err error) error { return classifyMembershipReadError(path, subject, err) })
}

// classifyMembershipReadError maps the common failure statuses of the
// read-only membership endpoints to actionable messages, mirroring
// ClassifyOrgInviteError's 403/404 handling. `subject` is a human label for the
// thing being read. Other statuses return the wrapped error.
func classifyMembershipReadError(path, subject string, err error) error {
	httpErr, ok := errors.AsType[*githubapi.HTTPError](err)
	if !ok {
		return fmt.Errorf("GET %s: %w", path, err)
	}
	switch httpErr.StatusCode {
	case http.StatusNotFound:
		return fmt.Errorf("%s: not found or not accessible", subject)
	case http.StatusForbidden:
		switch membership.ClassifyOrgForbidden(httpErr) {
		case membership.OrgForbiddenScopeMissing:
			return membership.ErrMissingOrgAdminScope
		case membership.OrgForbiddenNotAdmin:
			return fmt.Errorf("%s: forbidden — you may not have admin access to read it", subject)
		default:
			return fmt.Errorf("%s: forbidden — ensure your token has the admin:org scope (`gh teacher login`) and that you have access", subject)
		}
	}
	return fmt.Errorf("GET %s: %w", path, err)
}

func renderMemberList(out, errOut io.Writer, target string, entries []memberListEntry, asJSON, quiet bool) error {
	if asJSON {
		if entries == nil {
			entries = []memberListEntry{}
		}
		data, err := output.JSONPretty(entries)
		if err != nil {
			return err
		}
		_, _ = out.Write(data)
		return nil
	}

	if quiet {
		for _, e := range entries {
			_, _ = fmt.Fprintln(out, e.Login)
		}
		return nil
	}

	tw := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "LOGIN\tKIND\tROLE\tGITHUB_ID")
	for _, e := range entries {
		githubID := "-"
		if e.GitHubID != 0 {
			githubID = strconv.FormatInt(e.GitHubID, 10)
		}
		role := e.Role
		if role == "" {
			role = "-"
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", e.Login, e.Kind, role, githubID)
	}
	_ = tw.Flush()
	_, _ = fmt.Fprintln(errOut, summarizeMemberList(target, entries))
	return nil
}

// summarizeMemberList: one-line stderr summary `<target>: <message>`. A repo
// target reports collaborators; an org target reports members + pending.
func summarizeMemberList(target string, entries []memberListEntry) string {
	isRepo := strings.Contains(target, "/")
	if len(entries) == 0 {
		if isRepo {
			return fmt.Sprintf("%s: no collaborators found", target)
		}
		return fmt.Sprintf("%s: no members found", target)
	}
	var members, invitations, collaborators int
	for _, e := range entries {
		switch e.Kind {
		case memberKindOrgMember:
			members++
		case memberKindOrgInvitation:
			invitations++
		case memberKindCollaborator:
			collaborators++
		}
	}
	if isRepo {
		return fmt.Sprintf("%s: %d collaborator(s)", target, collaborators)
	}
	return fmt.Sprintf("%s: %d member(s) (%d active, %d pending)", target, members+invitations, members, invitations)
}
