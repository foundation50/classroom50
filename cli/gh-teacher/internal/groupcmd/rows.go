// Package groupcmd implements `gh teacher group`: read-only views of who
// belongs to which group of a group or team assignment, joined against the
// roster. Only NewCmd is exported.
package groupcmd

import (
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/configrepo"
)

// member is one group member. ID is 0 when the read carried no id. A Fallback
// member is derived from the repository name (a legacy founder), not from a
// live read: it is exported only when it resolves to a roster row or the group
// has no other member, so a founder who renamed their account does not
// reappear as a stranger beside their id-bearing collaborator entry.
type member struct {
	Login    string
	ID       int64
	Fallback bool
}

// groupSource is one group as either mode resolves it; a legacy group leaves
// Name and TeamSlug empty.
type groupSource struct {
	// The scores.json owner key: `group-<n>` (team) or the founder login (legacy).
	Group    string
	Name     string
	TeamSlug string
	Repo     string
	// nil when the live read failed, empty for a group with no members yet.
	Members []member
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

// resolved is one deduplicated member with its roster row (a placeholder for
// an unrostered login) and the precomputed sort key.
type resolved struct {
	row   configrepo.RosterRow
	key   string
	known bool
}

// buildRows expands groups to one row per member. A member joins to the roster
// by GitHub id first (so a renamed account keeps its row), then by lowercased
// login. Groups order naturally (group-2 before group-10); members by the
// web's last-name sort key. A group with no members, or whose members could
// not be read, still yields one row so it stays visible.
func buildRows(groups []groupSource, roster []configrepo.RosterRow) []memberRow {
	byID := make(map[int64]configrepo.RosterRow, len(roster))
	byLogin := make(map[string]configrepo.RosterRow, len(roster))
	for _, r := range roster {
		if r.GitHubID != 0 {
			if _, dup := byID[r.GitHubID]; !dup {
				byID[r.GitHubID] = r
			}
		}
		login := loginKey(r.Username)
		if login == "" {
			continue
		}
		if _, dup := byLogin[login]; !dup {
			byLogin[login] = r
		}
	}
	resolve := func(m member) (configrepo.RosterRow, bool) {
		if m.ID != 0 {
			if r, ok := byID[m.ID]; ok {
				return r, true
			}
		}
		r, ok := byLogin[loginKey(m.Login)]
		return r, ok
	}

	ordered := slices.Clone(groups)
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
		hasLive := slices.ContainsFunc(g.Members, func(m member) bool { return !m.Fallback })
		// Dedupe on the resolved identity: a legacy founder is also a
		// collaborator, possibly under a renamed login. An unrostered member's
		// username is the lowercased live login so both surfaces spell it the
		// same way.
		seen := map[string]bool{}
		members := make([]resolved, 0, len(g.Members))
		for _, m := range g.Members {
			login := strings.TrimSpace(m.Login)
			if login == "" {
				continue
			}
			r, known := resolve(m)
			if !known && m.Fallback && hasLive {
				continue
			}
			if !known {
				r = configrepo.RosterRow{Username: strings.ToLower(login)}
			}
			key := loginKey(r.Username)
			if seen[key] {
				continue
			}
			seen[key] = true
			members = append(members, resolved{row: r, key: sortKey(r), known: known})
		}
		if len(members) == 0 {
			rows = append(rows, base)
			continue
		}
		// Natural order on the same key the web sorts by (naturalCompare over
		// studentSortKeyByLastName), so both files list a group's members in the
		// same order in every locale.
		sort.SliceStable(members, func(i, j int) bool {
			if members[i].key != members[j].key {
				return naturalLess(members[i].key, members[j].key)
			}
			return naturalLess(members[i].row.Username, members[j].row.Username)
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
				row.GitHubID = strconv.FormatInt(m.row.GitHubID, 10)
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

// loginKey is the case-insensitive join key for a GitHub login.
func loginKey(login string) string {
	return strings.ToLower(strings.TrimSpace(login))
}

// sortKey is the web's last-name sort key (studentSortKeyByLastName): "Last
// First", falling back to the login, then the email, for a nameless row.
func sortKey(r configrepo.RosterRow) string {
	name := strings.TrimSpace(strings.TrimSpace(r.LastName) + " " + strings.TrimSpace(r.FirstName))
	if name == "" {
		name = strings.TrimSpace(r.Username)
	}
	if name == "" {
		name = strings.TrimSpace(r.Email)
	}
	return strings.ToLower(name)
}

// naturalLess is a locale-independent natural order: case-folded code points
// (UTF-8 byte order equals code-point order) with digit runs compared as
// numbers, leading zeros ignored. Mirrors naturalCompare in
// web/src/domain/submissions/groupMembershipCsv.ts, pinned by the shared
// fixture, so both exports order groups and members identically.
func naturalLess(a, b string) bool {
	a, b = strings.ToLower(a), strings.ToLower(b)
	for a != "" && b != "" {
		if isDigit(a[0]) && isDigit(b[0]) {
			an, arest := leadingNumber(a)
			bn, brest := leadingNumber(b)
			if an != bn {
				// Shorter digit run = smaller number; same length compares lexically.
				return len(an) < len(bn) || (len(an) == len(bn) && an < bn)
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

// leadingNumber splits the digit run off the front of s, stripped of leading
// zeros ("0" for an all-zero run).
func leadingNumber(s string) (digits, rest string) {
	i := 0
	for i < len(s) && isDigit(s[i]) {
		i++
	}
	digits = strings.TrimLeft(s[:i], "0")
	if digits == "" {
		digits = "0"
	}
	return digits, s[i:]
}
