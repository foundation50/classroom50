// Package teamcmd implements `gh student team`: the student-facing commands
// for the GitHub Team behind a `mode: team` assignment — listing your group
// and (for the founder of a student-formed group) adding teammates. Extracted
// command package beside invitecmd; only NewCmd is exported. Consumes the
// internal seams (githubapi, assignments, groupteam) + contract, never main.
package teamcmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/classroomcfg"
	"github.com/foundation50/gh-student/internal/githubapi"
	"github.com/foundation50/gh-student/internal/groupteam"
)

func NewCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "team",
		Short: "Manage your group for a team assignment",
		Long: "Team assignments use one shared repository per group, owned by a\n" +
			"GitHub Team. These commands work on YOUR group for an assignment:\n\n" +
			"  list  show your group and its members\n" +
			"  add   add a classmate to your group (founders only)\n\n" +
			"Create a group in the first place with `gh student accept --new-team`\n" +
			"(student-formed groups only; otherwise your teacher assigns them).",
	}
	cmd.AddCommand(teamListCmd())
	cmd.AddCommand(teamAddCmd())
	return cmd
}

// scopeArgs validates the shared <org> <classroom> <assignment> triple.
func scopeArgs(args []string) (org, classroom, assignment string, err error) {
	org = strings.TrimSpace(args[0])
	classroom = strings.TrimSpace(args[1])
	assignment = strings.TrimSpace(args[2])
	if org == "" || classroom == "" || assignment == "" {
		return "", "", "", errors.New("invalid arguments: org, classroom, and assignment must all be non-empty")
	}
	return org, classroom, assignment, nil
}

// addKeyFlag registers the --key flag both subcommands take (the access key
// for a classroom that uses an unlisted URL) and returns its destination.
func addKeyFlag(cmd *cobra.Command) *string {
	key := new(string)
	cmd.Flags().StringVar(key, "key", "", "Access key from your teacher for a classroom that uses an unlisted URL; omit for normal classrooms")
	return key
}

func teamListCmd() *cobra.Command {
	var key *string
	cmd := &cobra.Command{
		Use:   "list <org> <classroom> <assignment>",
		Short: "Show your group for a team assignment",
		Long: "Show the group you are in for a team assignment and who is on it.\n" +
			"Your group is resolved from your own GitHub team memberships, so no\n" +
			"special access is needed.",
		Example: "  gh student team list cs50 cs50-fall-2026 project",
		Args:    cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org, classroom, assignment, err := scopeArgs(args)
			if err != nil {
				return err
			}
			secret := strings.TrimSpace(*key)
			if err := validateKey(secret); err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runTeamList(cmd.Context(), client, cmd.OutOrStdout(), org, classroom, assignment, secret)
		},
	}
	key = addKeyFlag(cmd)
	return cmd
}

func runTeamList(ctx context.Context, client githubapi.Client, out io.Writer, org, classroom, assignment, secret string) error {
	membership, found, err := groupteam.MyTeam(client, org, classroom, assignment)
	if err != nil {
		return err
	}
	if !found {
		return notOnTeamError(ctx, org, classroom, assignment, secret)
	}
	members, err := groupteam.ListMembers(client, org, membership.Slug)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "You are in group %d for %s (%s)\n", membership.Counter, assignment, membership.Slug)
	_, _ = fmt.Fprintf(out, "Members (%d):\n", len(members))
	for _, m := range members {
		_, _ = fmt.Fprintf(out, "  %s\n", m)
	}
	_, _ = fmt.Fprintf(out, "\nShared repository: %s/%s\n", org, contract.GroupRepoName(classroom, assignment, membership.Counter))
	return nil
}

// notOnTeamError explains the two ways to get a group, keyed on the
// assignment's team_formation when the published entry is reachable. The
// entry fetch is best-effort — without it the message covers both cases.
func notOnTeamError(ctx context.Context, org, classroom, assignment, secret string) error {
	entry, err := assignments.FetchEntry(ctx, org, classroom, secret, assignment)
	if err == nil {
		switch {
		case entry.Mode != contract.ModeTeam:
			return fmt.Errorf("assignment %q is not a team assignment (mode %q), so it has no groups", assignment, entry.Mode)
		case entry.TeamFormation == contract.TeamFormationTeacher:
			return fmt.Errorf("you are not in a group for %q yet. Your teacher assigns the groups for this assignment; ask them to add you to one", assignment)
		default:
			return fmt.Errorf("you are not in a group for %q yet. Create one with `gh student accept %s %s %s --new-team`, or ask a teammate who already has a group to add you",
				assignment, org, classroom, assignment)
		}
	}
	return fmt.Errorf("you are not in a group for %q yet. Create one with `gh student accept %s %s %s --new-team` (student-formed groups), or ask your teacher to add you to one",
		assignment, org, classroom, assignment)
}

func teamAddCmd() *cobra.Command {
	var key *string
	cmd := &cobra.Command{
		Use:   "add <org> <classroom> <assignment> <username>",
		Short: "Add a classmate to your group",
		Long: "Add <username> to your group for a team assignment. They get push\n" +
			"access to the group's shared repository through the GitHub Team.\n\n" +
			"  - Only the group's founder (its team maintainer) can add members\n" +
			"    on a student-formed assignment.\n" +
			"  - The classmate must be enrolled in the classroom, and can be in\n" +
			"    only one group for the assignment.\n" +
			"  - The group size is capped by the assignment's maximum group\n" +
			"    size. The limit is advisory and is checked again when your\n" +
			"    teacher collects the work.\n" +
			"  - Adding someone who is already in the group changes nothing.",
		Example: "  gh student team add cs50 cs50-fall-2026 project cs50-duck",
		Args:    cobra.ExactArgs(4),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org, classroom, assignment, err := scopeArgs(args[:3])
			if err != nil {
				return err
			}
			username := strings.TrimSpace(args[3])
			if username == "" {
				return errors.New("username must not be empty")
			}
			secret := strings.TrimSpace(*key)
			if err := validateKey(secret); err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runTeamAdd(cmd.Context(), client, cmd.OutOrStdout(), cmd.ErrOrStderr(), org, classroom, assignment, secret, username)
		},
	}
	key = addKeyFlag(cmd)
	return cmd
}

func runTeamAdd(ctx context.Context, client githubapi.Client, out, errOut io.Writer, org, classroom, assignment, secret, username string) error {
	entry, err := assignments.FetchEntry(ctx, org, classroom, secret, assignment)
	if err != nil {
		return err
	}
	if entry.Mode != contract.ModeTeam {
		return fmt.Errorf("assignment %q is not a team assignment (mode %q); for a group assignment use `gh student invite`", assignment, entry.Mode)
	}
	membership, found, err := groupteam.MyTeam(client, org, classroom, assignment)
	if err != nil {
		return err
	}
	if !found {
		return notOnTeamError(ctx, org, classroom, assignment, secret)
	}

	// Enrollment gate for the teammate, mirroring accept's own gate: a
	// definitive not-enrolled blocks with a remedy; a transient read warns
	// and proceeds (the advisory cap must not block on a blip) — collection
	// re-checks enrollment when crediting anyway.
	enrolled, err := isEnrolled(client, org, classroom, username)
	if err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: couldn't check whether %s is enrolled in %s (%v); adding them anyway. They are only credited while enrolled.\n", username, classroom, err)
	} else if !enrolled {
		return fmt.Errorf("%s is not enrolled in %s: ask your teacher to add them to the classroom first, then re-run", username, classroom)
	}

	// One student, one group: refuse when the classmate is already in another
	// of the assignment's visible groups. Best-effort like the enrollment
	// gate — a failed read warns and proceeds (collection re-checks and the
	// teacher's snapshot diff surfaces any overlap that slips through).
	if otherCounter, taken, err := inAnotherGroup(client, org, classroom, assignment, username, membership.Slug); err != nil {
		_, _ = fmt.Fprintf(errOut, "Warning: couldn't check whether %s is already in another group (%v); adding them anyway.\n", username, err)
	} else if taken {
		return fmt.Errorf("%s is already in group %d for %s, and a student can be in only one group. They can leave that group from its page on GitHub, or ask your teacher to move them, then re-run",
			username, otherCounter, assignment)
	}

	members, err := groupteam.ListMembers(client, org, membership.Slug)
	if err != nil {
		return err
	}
	alreadyMember, err := checkTeamCapacity(members, username, entry.MaxGroupSize)
	if err != nil {
		return err
	}
	if alreadyMember {
		_, _ = fmt.Fprintf(out, "%s is already in group %d, nothing to do\n", username, membership.Counter)
		return nil
	}

	if err := groupteam.AddMember(ctx, client, org, membership.Slug, username); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "Added %s to group %d for %s\n", username, membership.Counter, assignment)
	_, _ = fmt.Fprintf(out, "They can now run: gh student accept %s %s %s\n", org, classroom, assignment)
	return nil
}

// inAnotherGroup reports whether username holds an active or pending
// membership on one of the assignment's group teams other than ownSlug,
// returning that group's counter for the refusal message.
func inAnotherGroup(client githubapi.Client, org, classroom, assignment, username, ownSlug string) (counter int, taken bool, err error) {
	slugs, err := groupteam.VisibleTeamSlugs(client, org, classroom, assignment)
	if err != nil {
		return 0, false, err
	}
	for _, slug := range slugs {
		if strings.EqualFold(slug, ownSlug) {
			continue
		}
		state, found, err := teamMembershipState(client, org, slug, username)
		if err != nil {
			return 0, false, err
		}
		if found && (state == "active" || state == "pending") {
			counter, _ := contract.ParseGroupTeamCounter(slug, classroom, assignment)
			return counter, true, nil
		}
	}
	return 0, false, nil
}

// checkTeamCapacity applies the max_group_size cap to a prospective add:
// an existing member is never blocked (re-adding is a no-op), and a full
// group (live count at/over the limit; 0 = no limit) refuses with a remedy.
// Pure so the cap contract is unit-testable.
func checkTeamCapacity(members []string, username string, limit int) (alreadyMember bool, err error) {
	for _, m := range members {
		if strings.EqualFold(m, username) {
			return true, nil
		}
	}
	if limit > 0 && len(members) >= limit {
		return false, fmt.Errorf("your group is full: it has %d member(s), the maximum of %d for this assignment; ask your teacher to raise the assignment's maximum group size if you need more",
			len(members), limit)
	}
	return false, nil
}

// isEnrolled reports whether username is on any of the classroom's teams
// (student or staff). Team members can read their own secret team's
// memberships, so the founder can check classmates on the same classroom
// team. A 404 on every team is a definitive "not enrolled"; any other error
// propagates so the caller can fail open.
func isEnrolled(client githubapi.Client, org, classroom, username string) (bool, error) {
	for _, slug := range contract.ClassroomTeamSlugs(classroom) {
		state, found, err := teamMembershipState(client, org, slug, username)
		if err != nil {
			return false, err
		}
		if found && (state == "active" || state == "pending") {
			return true, nil
		}
	}
	return false, nil
}

// teamMembershipState reads one user's membership on one team. found=false on
// 404 (not a member, or a team the caller can't see — a staff team is
// invisible to students, which reads the same as absent and is fine here).
func teamMembershipState(client githubapi.Client, org, slug, username string) (state string, found bool, err error) {
	path := fmt.Sprintf("orgs/%s/teams/%s/memberships/%s", org, slug, username)
	var resp struct {
		State string `json:"state"`
	}
	if err := client.Get(path, &resp); err != nil {
		var httpErr *githubapi.HTTPError
		if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusNotFound {
			return "", false, nil
		}
		return "", false, fmt.Errorf("GET %s: %w", path, err)
	}
	return resp.State, true, nil
}

// validateKey validates a non-empty --key before any network call, mirroring
// accept ("" = unprotected classroom).
func validateKey(key string) error {
	if key == "" {
		return nil
	}
	return classroomcfg.ValidateSecret(key)
}
