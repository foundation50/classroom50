package configrepo

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// InviteDescription is the classroom50/invite/v1 record stored in a per-invite
// SECRET team's description: the invited email address, retained until the
// student accepts (after acceptance GitHub reports the login but no longer the
// address it was invited to). Deliberately PII-minimal — names and sections
// belong in roster.csv, joined by email.
//
// Mirrors schemas/invite-v1.schema.json and the web writer/reader
// (web/src/util/inviteTeam.ts) with no compile-time link; the shared vectors in
// cli/shared/testdata/invite_vectors.json pin both writers' exact bytes.
type InviteDescription struct {
	Schema string `json:"schema"`
	// The INVITED address, normalized (trim + lowercase).
	Email string `json:"email"`
	// The classroom this invite belongs to — the recovery scope, and what
	// scopes the team-name hash.
	Classroom string `json:"classroom"`
}

// ErrInviteTeamNotSecret means the invite team is not `secret` and could not be
// made secret. The record holds a plaintext email, so a closed/visible team
// would expose it to every org member — fail closed rather than write PII where
// students could read it.
var ErrInviteTeamNotSecret = errors.New("invite team is not secret")

// ErrInviteTeamNotEmpty means the team still had a member after the acting
// teacher was dropped. Nobody can legitimately be on it yet (the invitation
// isn't sent until EnsureInviteTeam returns), so a survivor is a teacher
// stranded by an earlier interrupted run — and with no role filter, a teacher on
// the team is exactly what a reconcile would misread as the accepted invitee.
var ErrInviteTeamNotEmpty = errors.New("invite team still has a member")

// NormalizeInviteEmail is the single normalization (trim + lowercase) shared by
// the team-name hash and the stored `email`, so the two can't disagree about
// which address a team belongs to — a mismatch would make the team unlocatable
// from its roster row. Mirrors the web's normalizeInviteEmail.
func NormalizeInviteEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// InviteTeamName is the deterministic team name for an (classroom, email)
// invite: `invite-<sha256(classroom \0 normalized-email)[:16 hex]>`. Scoping by
// classroom keeps the same address invited to two classrooms in one org on two
// distinct teams; the NUL separator prevents ("ab","c") and ("a","bc") from
// hashing the same bytes. The result is already slug-safe, so name == slug and
// the team is addressable without reading it back.
//
// Byte-mirrors the web's inviteTeamName — the shared vectors pin both.
func InviteTeamName(classroom, email string) string {
	sum := sha256.Sum256([]byte(classroom + "\x00" + NormalizeInviteEmail(email)))
	return contract.InviteTeamPrefix + hex.EncodeToString(sum[:])[:contract.InviteHashHexLen]
}

// MarshalInviteDescription encodes the classroom50/invite/v1 record for a team
// description. The record is always re-derived, never read-modify-written, so
// unknown fields a newer writer added are dropped on rewrite (tolerate-only
// additive evolution). The exact bytes matter: a reconcile compares
// descriptions for string equality, so the web's marshaller applies Go's
// json.Marshal escaping to produce these same bytes.
func MarshalInviteDescription(classroom, email string) (string, error) {
	out, err := json.Marshal(InviteDescription{
		Schema:    contract.InviteSchemaV1,
		Email:     NormalizeInviteEmail(email),
		Classroom: classroom,
	})
	if err != nil {
		return "", fmt.Errorf("encode invite description: %w", err)
	}
	return string(out), nil
}

// ParseInviteDescription reads a team description into the invite record,
// reporting ok=false when it is absent, non-JSON, or not a valid v1 record.
// Never errors: a team with a hand-edited or empty description simply yields no
// record and the caller skips it rather than failing the whole reconcile.
//
// Because the accepted invitee can edit their OWN team's description, this is a
// trust boundary — callers must additionally verify `email` hashes back to the
// team name (InviteTeamName) before binding it to a roster row.
func ParseInviteDescription(description string) (InviteDescription, bool) {
	var record InviteDescription
	if strings.TrimSpace(description) == "" {
		return InviteDescription{}, false
	}
	if err := json.Unmarshal([]byte(description), &record); err != nil {
		return InviteDescription{}, false
	}
	// Blank email/classroom are rejected as well as absent ones (the web's zod
	// mirror only requires presence): neither can identify a team or a roster
	// row, and every reader would discard them a step later anyway.
	if record.Schema != contract.InviteSchemaV1 || record.Email == "" || record.Classroom == "" {
		return InviteDescription{}, false
	}
	return record, true
}

// InviteTeamState is one invite team as a reconcile pass sees it: the validated
// record (nil when the description isn't a v1 record) and the creation time the
// GC age gate (contract.InviteTeamGCMinAge) needs. Members are read separately
// via ListTeamMembersWithIDs so a caller can order the two reads itself.
type InviteTeamState struct {
	Record *InviteDescription
	// Provisional is true when the description is exactly
	// contract.InviteProvisionalDescription: a team either tool created whose
	// invite is still mid-flight. Distinguishing it from any OTHER record-less
	// description matters — the latter is a hand edit (the accepted invitee owns
	// their own team) and needs a teacher's eyes, while this one is just a run in
	// progress.
	Provisional bool
	// Zero when GitHub omits or malforms created_at — a team whose age can't be
	// judged must never be reaped.
	CreatedAt time.Time
}

// ReadInviteTeam reads one invite team's description and created_at. ok=false
// means the team is gone (404), which reads as "nothing to reconcile"; any other
// failure propagates, because a degraded read must never masquerade as an absent
// team (that would let the GC reap a live invite). Mirrors the web's
// readInviteTeam minus the membership read.
func ReadInviteTeam(client githubapi.Client, org, slug string) (InviteTeamState, bool, error) {
	path := fmt.Sprintf("orgs/%s/teams/%s", url.PathEscape(org), url.PathEscape(slug))
	var payload struct {
		Description string `json:"description"`
		CreatedAt   string `json:"created_at"`
	}
	if err := client.Get(path, &payload); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return InviteTeamState{}, false, nil
		}
		return InviteTeamState{}, false, fmt.Errorf("GET %s (read invite team): %w", path, err)
	}
	var state InviteTeamState
	if record, ok := ParseInviteDescription(payload.Description); ok {
		state.Record = &record
	} else {
		state.Provisional = strings.TrimSpace(payload.Description) == contract.InviteProvisionalDescription
	}
	// An unparseable timestamp stays zero, so the age gate reads "too young".
	if created, err := time.Parse(time.RFC3339, payload.CreatedAt); err == nil {
		state.CreatedAt = created
	}
	return state, true, nil
}

// ListTeamMembersWithIDs is ListTeamMembers plus each member's numeric id, for
// the invite reconcile (which writes both onto the recovered roster row).
// Deliberately UNFILTERED by role: EnsureInviteTeam leaves no teacher on an
// invite team, so whoever is on it accepted — including an org owner, whom
// GitHub auto-promotes to maintainer and a role=member filter would hide.
// A 404 (team already deleted) yields no members, so the invite simply looks
// pending; any other failure propagates. A caller reading a team that MUST
// exist wants FindTeamMembersWithIDs instead.
func ListTeamMembersWithIDs(client githubapi.Client, org, slug string) ([]TeamMemberRef, error) {
	members, _, err := findTeamMembersWithIDs(client, org, slug)
	return members, err
}

// FindTeamMembersWithIDs is ListTeamMembersWithIDs with the 404 reported
// distinctly: found=false means GitHub has no such team. A classroom or staff
// team is expected to exist, and reading its absence (renamed, deleted, or a
// mistyped slug) as an empty membership would make every accepted invitee look
// unenrolled — which is what authorizes deleting the metadata team holding the
// only record of their invited address.
func FindTeamMembersWithIDs(client githubapi.Client, org, slug string) ([]TeamMemberRef, bool, error) {
	return findTeamMembersWithIDs(client, org, slug)
}

func findTeamMembersWithIDs(client githubapi.Client, org, slug string) ([]TeamMemberRef, bool, error) {
	found := true
	members, err := githubapi.PaginateAll[TeamMemberRef](
		client, githubapi.ListPerPage, githubapi.ListMaxPages,
		func(page int) string {
			return fmt.Sprintf("orgs/%s/teams/%s/members?per_page=%d&page=%d",
				url.PathEscape(org), url.PathEscape(slug), githubapi.ListPerPage, page)
		},
		func(path string, err error) error {
			if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
				found = false
				return nil // 404 sentinel: caller handles the empty result
			}
			return fmt.Errorf("GET %s: %w", path, err)
		},
	)
	if err != nil {
		return nil, false, err
	}
	out := make([]TeamMemberRef, 0, len(members))
	for _, m := range members {
		if strings.TrimSpace(m.Login) == "" {
			continue
		}
		out = append(out, m)
	}
	return out, found, nil
}

// EnsureInviteTeam creates (or adopts) the per-invite SECRET team for
// (classroom, email) and writes the classroom50/invite/v1 record into its
// description. `created` reports whether this call created the team, so a caller
// whose org invitation then fails deletes only what it created — an adopted team
// may hold a still-unrecovered record from an earlier invite.
//
// Three fail-closed invariants, each an error rather than a team that would leak
// PII or mislead a reconcile (mirroring the web's ensureInviteTeam):
//   - SECRET: the team is PATCHed to secret when GitHub reports it otherwise
//     (an adopted team may be closed), and if that can't be CONFIRMED,
//     ErrInviteTeamNotSecret — never store the email where students could read
//     it.
//   - NO TEACHER: GitHub silently adds the creator as a maintainer (and
//     auto-promotes any org owner it holds), so a teacher on the team is
//     indistinguishable from an invitee who accepted. `actor` is dropped
//     unconditionally (an adopted team may carry one from an earlier run) and the
//     membership is then READ BACK; a survivor is ErrInviteTeamNotEmpty. This is
//     what lets a reconcile treat any member of any role as the invitee.
//   - EMAIL LAST: the create carries only contract.InviteProvisionalDescription.
//     GitHub adds the creator during the create itself, so the drop is
//     necessarily a second request and an interrupted run can always strand a
//     team with a teacher on it. Writing the email last makes that leftover
//     harmless — it holds no address and no valid record, so a reconcile skips it
//     and the next invite to the same address adopts and heals it.
func EnsureInviteTeam(client githubapi.Client, org, classroom, email, actor string) (ref TeamRef, created bool, err error) {
	name := InviteTeamName(classroom, email)
	record, err := MarshalInviteDescription(classroom, email)
	if err != nil {
		return TeamRef{}, false, err
	}

	team, created, err := createOrAdoptInviteTeam(client, org, name)
	if err != nil {
		return TeamRef{}, created, err
	}

	// Settle the secret invariant BEFORE any membership call, so a team that
	// can't be secured is abandoned while it still holds no email.
	if team.Privacy != "secret" {
		// Its own PATCH: the email must never ride a request that is also still
		// trying to secure the team.
		if team, err = patchInviteTeam(client, org, team.Slug, map[string]any{"privacy": "secret"}); err != nil {
			return TeamRef{ID: team.ID, Slug: team.Slug}, created, err
		}
	}
	if team.Privacy != "secret" {
		return TeamRef{ID: team.ID, Slug: team.Slug}, created,
			fmt.Errorf("%w: %q at %s is %s: refusing to store an invited email on a team other org members could read; make it secret or delete it by hand", ErrInviteTeamNotSecret, team.Slug, org, team.Privacy)
	}

	if err := requireTeacherFreeInviteTeam(client, org, team.Slug, actor); err != nil {
		return TeamRef{ID: team.ID, Slug: team.Slug}, created, err
	}

	// Only now is it safe to store the invited address. Re-asserting privacy on
	// this PATCH closes the window in which the team could have been opened up
	// since the check above.
	patched, err := patchInviteTeam(client, org, team.Slug, map[string]any{
		"privacy": "secret", "description": record,
	})
	if err != nil {
		return TeamRef{ID: team.ID, Slug: team.Slug}, created, err
	}
	if patched.Privacy != "secret" {
		return TeamRef{ID: patched.ID, Slug: patched.Slug}, created,
			fmt.Errorf("%w: %q at %s came back %s after the record write; delete the team by hand, it holds an invited email", ErrInviteTeamNotSecret, patched.Slug, org, patched.Privacy)
	}
	return TeamRef{ID: patched.ID, Slug: patched.Slug}, created, nil
}

// createOrAdoptInviteTeam creates the secret team carrying only the provisional
// description, or on a 422 name collision (a resend, a retry, or a prior invite
// to the same address) reads the existing team to adopt. Returns the team's
// reported privacy for the caller's fail-closed check rather than assuming the
// requested `secret` took.
func createOrAdoptInviteTeam(client githubapi.Client, org, name string) (inviteTeamPayload, bool, error) {
	body, err := json.Marshal(map[string]any{
		"name":                 name,
		"privacy":              "secret",
		"description":          contract.InviteProvisionalDescription,
		"notification_setting": notificationsDisabled,
	})
	if err != nil {
		return inviteTeamPayload{}, false, fmt.Errorf("encode invite team body: %w", err)
	}
	createPath := fmt.Sprintf("orgs/%s/teams", url.PathEscape(org))
	var fresh inviteTeamPayload
	err = client.Post(createPath, bytes.NewReader(body), &fresh)
	if err == nil {
		if fresh.Slug == "" {
			// slug == name for this shape, but a response missing it would make
			// every later request address the wrong path.
			fresh.Slug = name
		}
		return fresh, true, nil
	}
	if !cliutil.IsHTTPStatus(err, http.StatusUnprocessableEntity) {
		return inviteTeamPayload{}, false, fmt.Errorf("POST %s: %w", createPath, err)
	}

	// Name is slug-safe, so it doubles as the lookup slug.
	getPath := fmt.Sprintf("orgs/%s/teams/%s", url.PathEscape(org), url.PathEscape(name))
	var existing inviteTeamPayload
	if getErr := client.Get(getPath, &existing); getErr != nil {
		// A 404 means the 422 wasn't a name collision after all — surface the
		// original create error, which says what GitHub actually rejected.
		if cliutil.IsHTTPStatus(getErr, http.StatusNotFound) {
			return inviteTeamPayload{}, false, fmt.Errorf("POST %s: %w", createPath, err)
		}
		return inviteTeamPayload{}, false, fmt.Errorf("GET %s (adopting existing invite team): %w", getPath, getErr)
	}
	if existing.Slug == "" {
		existing.Slug = name
	}
	return existing, false, nil
}

// requireTeacherFreeInviteTeam drops `actor`, then PROVES no member remains.
// GitHub adds the creator during the create, so the drop can't be atomic with
// it; the read-back is what turns the invariant from an assumption into a
// checked fact, and it also catches a DIFFERENT teacher stranded by an earlier
// run (whom dropping `actor` alone would miss). A degraded read errors rather
// than reading as "empty".
func requireTeacherFreeInviteTeam(client githubapi.Client, org, slug, actor string) error {
	if err := RemoveTeamMembership(client, org, slug, actor); err != nil {
		return err
	}
	members, err := ListTeamMembersWithIDs(client, org, slug)
	if err != nil {
		return err
	}
	if len(members) > 0 {
		return fmt.Errorf("%w: %q at %s still has %d member(s) after dropping %s, and a sync would misread them as the invitee; remove them from the team and retry",
			ErrInviteTeamNotEmpty, slug, org, len(members), actor)
	}
	return nil
}

// inviteTeamPayload is the team shape the invite paths decode: id/slug for
// addressing and privacy for the fail-closed secret check.
type inviteTeamPayload struct {
	ID      int64  `json:"id"`
	Slug    string `json:"slug"`
	Privacy string `json:"privacy"`
}

// patchInviteTeam applies a team PATCH and decodes the team GitHub returns, so
// the caller checks the SERVER's privacy rather than assuming the write took.
func patchInviteTeam(client githubapi.Client, org, slug string, patch map[string]any) (inviteTeamPayload, error) {
	body, err := json.Marshal(patch)
	if err != nil {
		return inviteTeamPayload{}, fmt.Errorf("encode invite team patch: %w", err)
	}
	path := fmt.Sprintf("orgs/%s/teams/%s", url.PathEscape(org), url.PathEscape(slug))
	resp, err := client.Request(http.MethodPatch, path, bytes.NewReader(body))
	if err != nil {
		return inviteTeamPayload{}, fmt.Errorf("PATCH %s (update invite team): %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	var payload inviteTeamPayload
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return inviteTeamPayload{}, fmt.Errorf("decode PATCH %s response: %w", path, err)
	}
	if payload.Slug == "" {
		payload.Slug = slug
	}
	return payload, nil
}
