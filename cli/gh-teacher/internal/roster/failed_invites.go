package roster

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"

	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/membership"
)

// failedInviteRecords is the org's failed-invitation list indexed by address,
// read once and only on first use. GitHub keeps a record of every invitation
// that expired, and once the address has a fresh invitation (or accepted one)
// that record is only noise on the org's People page. The web dismisses it
// right after a confirmed send (dismissFailedInvitation); the CLI's re-invite
// and sync do the same through this.
//
// Bookkeeping, never state: the list is owner-only, so a 403/404 reads as
// "nothing to dismiss", any other failed read or DELETE is a warning, and none
// of it can fail the send or the roster commit that came before.
type failedInviteRecords struct {
	client githubapi.Client
	org    string
	loaded bool
	// byEmail is nil after an unreadable list; every lookup then finds nothing.
	byEmail map[string][]int64
}

func (f *failedInviteRecords) load(errOut io.Writer) {
	if f.loaded {
		return
	}
	f.loaded = true
	list, err := membership.ListFailedOrgInvitations(f.client, f.org)
	if err != nil {
		if !cliutil.IsHTTPStatus(err, http.StatusForbidden) && !cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			_, _ = fmt.Fprintf(errOut, "Warning: %s: reading the failed invitations failed (%v); any expired record is left for you to dismiss from https://github.com/orgs/%s/people/failed_invitations.\n", f.org, err, f.org)
		}
		return
	}
	f.byEmail = map[string][]int64{}
	for _, inv := range list {
		// Login-keyed records belong to account invitations, which never had
		// an address to match a pending row on.
		if inv.ID == 0 || inv.Login != "" || inv.Email == "" {
			continue
		}
		key := configrepo.NormalizeInviteEmail(inv.Email)
		f.byEmail[key] = append(f.byEmail[key], inv.ID)
	}
}

// idsFor is the records an address still has, in id order so output is stable.
func (f *failedInviteRecords) idsFor(errOut io.Writer, email string) []int64 {
	f.load(errOut)
	ids := f.byEmail[configrepo.NormalizeInviteEmail(email)]
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// dismiss deletes every failed record for email and reports how many went. A
// record already gone counts as dismissed, since the outcome is the same.
func (f *failedInviteRecords) dismiss(out, errOut io.Writer, email string) {
	ids := f.idsFor(errOut, email)
	if len(ids) == 0 {
		return
	}
	dismissed := 0
	for _, id := range ids {
		if err := membership.CancelOrgInvitation(f.client, f.org, id); err != nil && !errors.Is(err, membership.ErrInvitationAlreadyGone) {
			_, _ = fmt.Fprintf(errOut, "Warning: %s: dismissing the expired invitation record %d for %s failed (%v); dismiss it from https://github.com/orgs/%s/people/failed_invitations.\n", f.org, id, email, err, f.org)
			continue
		}
		dismissed++
	}
	delete(f.byEmail, configrepo.NormalizeInviteEmail(email))
	if dismissed > 0 {
		_, _ = fmt.Fprintf(out, "%s: dismissed %d expired invitation record(s) for %s\n", f.org, dismissed, email)
	}
}
