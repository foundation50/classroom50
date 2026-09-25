// Package groupcmd implements `gh teacher group`: read-only views of who
// belongs to which group of a group or team assignment, joined against the
// roster, so a teacher can reconcile groups with an LMS. Only NewCmd is
// exported. The CSV shape is the cross-tool contract shared with the web app's
// "Download groups (CSV)" action (contract.GroupMembershipCSVColumns).
package groupcmd

import (
	"fmt"
	"sort"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/configrepo"
)

// groupSource is one group as either mode resolves it. Team mode fills every
// field; a legacy group leaves Name and TeamSlug empty. Members is nil when the
// live read failed (as opposed to empty for a group with no members yet), which
// the `note` column reports.
type groupSource struct {
	// The scores.json owner key: `group-<n>` (team) or the founder login (legacy).
	Group    string
	Name     string
	TeamSlug string
	// Empty for a team whose repo hasn't been created yet.
	Repo    string
	Members []string
}

// memberRow is one export row. Field order == contract.GroupMembershipCSVColumns
// (the JSON keys and the CSV cells are both emitted from it).
type memberRow struct {
	Group     string `json:"group"`
	GroupName string `json:"group_name"`
	TeamSlug  string `json:"team_slug"`
	Repo      string `json:"repo"`
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Email     string `json:"email"`
	Section   string `json:"section"`
	GitHubID  string `json:"github_id"`
	Role      string `json:"role"`
	InRoster  string `json:"in_roster"`
	Note      string `json:"note"`
}

// cells returns the row in contract column order.
func (r memberRow) cells() []string {
	return []string{
		r.Group, r.GroupName, r.TeamSlug, r.Repo,
		r.Username, r.FirstName, r.LastName, r.Email, r.Section, r.GitHubID, r.Role,
		r.InRoster, r.Note,
	}
}

// buildRows expands groups to one row per member, joined against the roster by
// lowercased login. Groups order naturally (group-2 before group-10; founder
// logins alphabetically); members by last name, first name, then login, the
// same order every roster view uses. A group with no members, or whose members
// could not be read, still yields one row so it stays visible. Pure so the
// shape is unit-testable without HTTP.
func buildRows(groups []groupSource, roster []configrepo.RosterRow) []memberRow {
	byLogin := make(map[string]configrepo.RosterRow, len(roster))
	for _, r := range roster {
		login := strings.ToLower(strings.TrimSpace(r.Username))
		if login == "" {
			continue
		}
		if _, dup := byLogin[login]; !dup {
			byLogin[login] = r
		}
	}

	ordered := append([]groupSource(nil), groups...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return naturalLess(ordered[i].Group, ordered[j].Group)
	})

	var rows []memberRow
	for _, g := range ordered {
		base := memberRow{Group: g.Group, GroupName: g.Name, TeamSlug: g.TeamSlug, Repo: g.Repo}
		if g.Members == nil {
			base.Note = contract.GroupMembershipNoteUnreadable
			rows = append(rows, base)
			continue
		}
		if len(g.Members) == 0 {
			rows = append(rows, base)
			continue
		}
		type member struct {
			login string
			row   configrepo.RosterRow
			known bool
		}
		seen := map[string]bool{}
		members := make([]member, 0, len(g.Members))
		for _, raw := range g.Members {
			login := strings.TrimSpace(raw)
			key := strings.ToLower(login)
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			r, known := byLogin[key]
			if !known {
				r = configrepo.RosterRow{Username: login}
			}
			members = append(members, member{login: login, row: r, known: known})
		}
		sort.SliceStable(members, func(i, j int) bool {
			a, b := sortKey(members[i].row, members[i].login), sortKey(members[j].row, members[j].login)
			if a != b {
				return a < b
			}
			return strings.ToLower(members[i].login) < strings.ToLower(members[j].login)
		})
		for _, m := range members {
			row := base
			row.Username = strings.TrimSpace(m.row.Username)
			row.FirstName = strings.TrimSpace(m.row.FirstName)
			row.LastName = strings.TrimSpace(m.row.LastName)
			row.Email = strings.TrimSpace(m.row.Email)
			row.Section = strings.TrimSpace(m.row.Section)
			row.Role = strings.TrimSpace(m.row.Role)
			if m.row.GitHubID != 0 {
				row.GitHubID = fmt.Sprintf("%d", m.row.GitHubID)
			}
			if m.known {
				row.InRoster = "yes"
			} else {
				row.InRoster = "no"
			}
			rows = append(rows, row)
		}
	}
	return rows
}

// sortKey is the web's last-name sort key (studentSortKeyByLastName): "Last
// First", falling back to the login, then the email, for a nameless row, so
// both exports order members identically.
func sortKey(r configrepo.RosterRow, login string) string {
	name := strings.TrimSpace(strings.TrimSpace(r.LastName) + " " + strings.TrimSpace(r.FirstName))
	if name == "" {
		name = strings.TrimSpace(login)
	}
	if name == "" {
		name = strings.TrimSpace(r.Email)
	}
	return strings.ToLower(name)
}

// naturalLess orders strings with embedded numbers numerically, so team keys
// sort group-2 < group-10 while founder logins still sort alphabetically.
func naturalLess(a, b string) bool {
	a, b = strings.ToLower(a), strings.ToLower(b)
	for a != "" && b != "" {
		ad, bd := isDigit(a[0]), isDigit(b[0])
		if ad && bd {
			an, arest := leadingNumber(a)
			bn, brest := leadingNumber(b)
			if an != bn {
				return an < bn
			}
			a, b = arest, brest
			continue
		}
		if a[0] != b[0] {
			return a[0] < b[0]
		}
		a, b = a[1:], b[1:]
	}
	return len(a) < len(b)
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// leadingNumber splits a digit run off the front of s. Digits are compared by
// length-then-value so a run too long for an int still orders correctly.
func leadingNumber(s string) (string, string) {
	i := 0
	for i < len(s) && isDigit(s[i]) {
		i++
	}
	num := strings.TrimLeft(s[:i], "0")
	if num == "" {
		num = "0"
	}
	// Pad to a fixed width so lexical compare equals numeric compare.
	return fmt.Sprintf("%030s", num), s[i:]
}
