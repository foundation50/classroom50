package servicetoken

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/crypto/nacl/box"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

func TestServiceSecretExists(t *testing.T) {
	cases := []struct {
		name   string
		status int
		want   bool
		errNil bool
	}{
		{"exists", http.StatusOK, true, true},
		{"absent", http.StatusNotFound, false, true},
		{"other error", http.StatusInternalServerError, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.status == http.StatusOK {
					_, _ = w.Write([]byte(`{"name":"CLASSROOM50_SERVICE_TOKEN"}`))
					return
				}
				w.WriteHeader(tc.status)
			}))
			t.Cleanup(server.Close)
			client := githubtest.NewTestClient(t, server)

			got, err := SecretExists(client, "o", "classroom50")
			if got != tc.want {
				t.Errorf("exists = %v, want %v", got, tc.want)
			}
			if tc.errNil && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			if !tc.errNil && err == nil {
				t.Errorf("expected an error for status %d", tc.status)
			}
		})
	}
}

func TestValidateServiceToken(t *testing.T) {
	cases := []struct {
		name string
		// repoStatus/canPush/canAdmin describe the GET /repos/{org}/classroom50
		// response; membersStatus describes the follow-on
		// GET /orgs/{org}/members probe (only reached on a 200 push+admin repo).
		repoStatus    int
		canPush       bool
		canAdmin      bool
		membersStatus int
		wantErr       bool
		errSubstr     string
		// wantWarn is true when validation should pass but emit the
		// inconclusive-Members-scope advisory to its writer (fail-open branch).
		wantWarn bool
	}{
		{"valid read+write+admin+members", http.StatusOK, true, true, http.StatusOK, false, "", false},
		{"read-only rejected", http.StatusOK, false, false, http.StatusOK, true, "lacks write access", false},
		{"write-but-no-admin rejected", http.StatusOK, true, false, http.StatusOK, true, "lacks admin access", false},
		{"revoked", http.StatusUnauthorized, false, false, 0, true, "invalid, expired, or revoked", false},
		{"no repo access", http.StatusNotFound, false, false, 0, true, "can't read", false},
		{"repo forbidden", http.StatusForbidden, false, false, 0, true, "can't read", false},
		{"members forbidden", http.StatusOK, true, true, http.StatusForbidden, true, "can't read the org's members", false},
		{"members not found", http.StatusOK, true, true, http.StatusNotFound, true, "can't read the org's members", false},
		// FAIL-OPEN: a 401 or 5xx on the members probe (after a 200 repo read
		// that already proved the token live) is inconclusive, not fatal — the
		// probe must not reject a valid token on GitHub-side flakiness, but it
		// MUST warn so the teacher knows to run probe-token before relying on it.
		{"members unauthorized proceeds", http.StatusOK, true, true, http.StatusUnauthorized, false, "", true},
		{"members server error proceeds", http.StatusOK, true, true, http.StatusInternalServerError, false, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var sawRepo, sawMembers bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				// Validation first reads the config repo (GET
				// /repos/{org}/classroom50) to assert
				// permissions.push AND permissions.admin, then probes
				// org members (GET /orgs/{org}/members) for the
				// Members: Read scope.
				case strings.HasSuffix(r.URL.Path, "/repos/cs50/classroom50"):
					sawRepo = true
					if tc.repoStatus == http.StatusOK {
						_, _ = w.Write([]byte(`{"permissions":{"push":` + boolJSON(tc.canPush) + `,"admin":` + boolJSON(tc.canAdmin) + `}}`))
						return
					}
					w.WriteHeader(tc.repoStatus)
				case strings.HasSuffix(r.URL.Path, "/orgs/cs50/members"):
					sawMembers = true
					if tc.membersStatus == http.StatusOK {
						_, _ = w.Write([]byte(`[]`))
						return
					}
					w.WriteHeader(tc.membersStatus)
				default:
					t.Errorf("unexpected request path %s", r.URL.Path)
				}
			}))
			t.Cleanup(server.Close)
			client := githubtest.NewTestClient(t, server)

			var warnOut strings.Builder
			err := validateTokenWithClient(client, "cs50", &warnOut)
			if tc.wantErr && err == nil {
				t.Fatalf("expected an error (repo=%d canPush=%v canAdmin=%v members=%d)", tc.repoStatus, tc.canPush, tc.canAdmin, tc.membersStatus)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.errSubstr != "" && !strings.Contains(err.Error(), tc.errSubstr) {
				t.Errorf("error %q should contain %q", err.Error(), tc.errSubstr)
			}
			gotWarn := strings.Contains(warnOut.String(), "probe-token")
			if gotWarn != tc.wantWarn {
				t.Errorf("inconclusive-scope warning = %v, want %v (out=%q)", gotWarn, tc.wantWarn, warnOut.String())
			}
			if !sawRepo {
				t.Error("validation should always GET the config repo")
			}
			// The members probe is only reachable once the config repo
			// returns 200 with push AND admin access. On any earlier failure
			// it must NOT be hit (fail fast on the Contents/Administration
			// checks).
			wantMembersProbe := tc.repoStatus == http.StatusOK && tc.canPush && tc.canAdmin
			if sawMembers != wantMembersProbe {
				t.Errorf("members probe reached = %v, want %v", sawMembers, wantMembersProbe)
			}
			// The no-access repo message must carry the actionable fix,
			// including the now-required Read-and-write scope.
			if tc.repoStatus == http.StatusNotFound {
				if !strings.Contains(err.Error(), "Resource owner") ||
					!strings.Contains(err.Error(), "Contents: Read and write") {
					t.Errorf("no-access error should explain the resource-owner + Contents: Read and write fix: %q", err.Error())
				}
			}
			// A read-only token must be told it needs write.
			if tc.repoStatus == http.StatusOK && !tc.canPush {
				if !strings.Contains(err.Error(), "Contents: Read and write") {
					t.Errorf("read-only error should explain the Contents: Read and write fix: %q", err.Error())
				}
			}
			// A write-but-no-admin token must be told to add Administration.
			if tc.repoStatus == http.StatusOK && tc.canPush && !tc.canAdmin {
				if !strings.Contains(err.Error(), "Administration: Read and write") {
					t.Errorf("no-admin error should explain the Administration: Read and write fix: %q", err.Error())
				}
			}
			// A Members-less token must be told to add Members: Read.
			if tc.repoStatus == http.StatusOK && tc.canPush && tc.canAdmin &&
				(tc.membersStatus == http.StatusForbidden || tc.membersStatus == http.StatusNotFound) {
				if !strings.Contains(err.Error(), "Members: Read") {
					t.Errorf("members-denied error should explain the Members: Read fix: %q", err.Error())
				}
			}
		})
	}
}

// boolJSON renders a Go bool as a JSON literal for inline response bodies.
func boolJSON(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// TestValidateRepoScope pins the "All repositories" probe: the teacher's client
// lists private org repos, the token reads the first one that isn't
// classroom50, and only a 404 there rejects the token. A token scoped to
// selected repositories passes every config-repo check (discussion #768), so
// this probe is the one place the misconfiguration can be caught before it
// shows up as a collect-time 403 on the first staff-team grant.
func TestValidateRepoScope(t *testing.T) {
	cases := []struct {
		name string
		// listing is the teacher's GET /orgs/cs50/repos body (or a status).
		listStatus int
		listing    string
		// probeStatus is the token's GET /repos/cs50/<probe> status.
		probeStatus int
		wantProbe   string // "" when no probe should be made
		wantErr     bool
		wantWarn    bool
	}{
		{"all repositories", http.StatusOK, `[{"name":"classroom50"},{"name":"cs-hw1-alice"}]`, http.StatusOK, "cs-hw1-alice", false, false},
		{"selected repositories rejected", http.StatusOK, `[{"name":"classroom50"},{"name":"cs-hw1-alice"}]`, http.StatusNotFound, "cs-hw1-alice", true, false},
		{"config repo is never the probe", http.StatusOK, `[{"name":"Classroom50"},{"name":"other"}]`, http.StatusOK, "other", false, false},
		{"only the config repo exists: nothing to prove", http.StatusOK, `[{"name":"classroom50"}]`, 0, "", false, false},
		{"no private repos: nothing to prove", http.StatusOK, `[]`, 0, "", false, false},
		{"teacher listing fails: inconclusive", http.StatusInternalServerError, ``, 0, "", false, true},
		{"probe 403 is inconclusive, not a scope verdict", http.StatusOK, `[{"name":"cs-hw1-alice"}]`, http.StatusForbidden, "cs-hw1-alice", false, true},
		{"probe 5xx is inconclusive", http.StatusOK, `[{"name":"cs-hw1-alice"}]`, http.StatusBadGateway, "cs-hw1-alice", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var probed []string
			teacherServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.HasSuffix(r.URL.Path, "/orgs/cs50/repos") {
					t.Errorf("teacher client: unexpected request %s", r.URL.Path)
				}
				if got := r.URL.Query().Get("type"); got != "private" {
					t.Errorf("listing type = %q, want private (a public repo proves nothing)", got)
				}
				if tc.listStatus != http.StatusOK {
					w.WriteHeader(tc.listStatus)
					return
				}
				_, _ = w.Write([]byte(tc.listing))
			}))
			t.Cleanup(teacherServer.Close)
			tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				probed = append(probed, strings.TrimPrefix(r.URL.Path, "/repos/cs50/"))
				if tc.probeStatus != http.StatusOK {
					w.WriteHeader(tc.probeStatus)
					return
				}
				_, _ = w.Write([]byte(`{"name":"x"}`))
			}))
			t.Cleanup(tokenServer.Close)

			var warnOut strings.Builder
			err := validateRepoScopeWithClients(
				githubtest.NewTestClient(t, tokenServer),
				githubtest.NewTestClient(t, teacherServer),
				"cs50", &warnOut,
			)
			if tc.wantErr != (err != nil) {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantErr && (!strings.Contains(err.Error(), "All repositories") || !strings.Contains(err.Error(), "cs50/cs-hw1-alice")) {
				t.Errorf("rejection should name the unreadable repo and the All repositories fix: %q", err.Error())
			}
			if tc.wantWarn != strings.Contains(warnOut.String(), "probe-token") {
				t.Errorf("inconclusive warning = %v, want %v (out=%q)", !tc.wantWarn, tc.wantWarn, warnOut.String())
			}
			if tc.wantProbe == "" && len(probed) != 0 {
				t.Errorf("token must not be used when there is nothing to prove; probed %v", probed)
			}
			if tc.wantProbe != "" && (len(probed) != 1 || probed[0] != tc.wantProbe) {
				t.Errorf("probed %v, want exactly [%s]", probed, tc.wantProbe)
			}
		})
	}
}

// TestProvisionServiceSecret_PutStatus pins the PUT status handling: the
// Actions-secret upload must succeed on 201 (created) and 204 (updated),
// and the new assertion must reject any other 2xx (e.g., a 200 that means
// the write didn't land as a create/update) rather than reporting a
// stored token. The handler serves a valid NaCl public key on the GET so
// sealbox encryption succeeds and the flow reaches the PUT.
func TestProvisionServiceSecret_PutStatus(t *testing.T) {
	pub, _, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	keyB64 := base64.StdEncoding.EncodeToString(pub[:])

	cases := []struct {
		name      string
		putStatus int
		wantErr   bool
	}{
		{"created", http.StatusCreated, false},
		{"updated", http.StatusNoContent, false},
		{"unexpected 2xx rejected", http.StatusOK, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/repos/o/classroom50/actions/secrets/public-key", func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]string{"key_id": "kid-1", "key": keyB64})
			})
			mux.HandleFunc("/repos/o/classroom50/actions/secrets/CLASSROOM50_SERVICE_TOKEN", func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPut {
					t.Errorf("secret upload method = %s, want PUT", r.Method)
				}
				w.WriteHeader(tc.putStatus)
			})
			server := httptest.NewServer(mux)
			t.Cleanup(server.Close)
			client := githubtest.NewTestClient(t, server)

			err := ProvisionSecret(client, io.Discard, "o", "classroom50", []byte("ghp_test"), "stored")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("status %d should be rejected by the 201/204 assertion", tc.putStatus)
				}
				if !strings.Contains(err.Error(), "unexpected status") {
					t.Errorf("error %q should mention 'unexpected status'", err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("status %d should succeed, got %v", tc.putStatus, err)
			}
		})
	}
}

// The rotate command's help spells the token requirements as a bullet list and
// the permission-shaped rejections quote RequiredTokenPermissions; both must
// name the same settings, or a permission added to one is invisible in the
// other.
func TestRotateHelpNamesEveryRequiredTokenPermission(t *testing.T) {
	// The help wraps at ~70 columns, so a phrase may straddle a line break.
	long := strings.Join(strings.Fields(NewRotateCmd().Long), " ")
	for _, phrase := range []string{
		"All repositories",
		"Contents: Read and write",
		"Actions: Read and write",
		"Administration: Read and write",
		"Members: Read",
	} {
		if !strings.Contains(RequiredTokenPermissions, phrase) {
			t.Errorf("RequiredTokenPermissions no longer names %q", phrase)
		}
		if !strings.Contains(long, phrase) {
			t.Errorf("rotate-service-token help no longer names %q; keep it in step with RequiredTokenPermissions", phrase)
		}
	}
}
