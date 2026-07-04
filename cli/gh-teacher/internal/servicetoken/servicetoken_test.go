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
		// repoStatus/canPush describe the GET /repos/{org}/classroom50
		// response; membersStatus describes the follow-on
		// GET /orgs/{org}/members probe (only reached on a 200 push repo).
		repoStatus    int
		canPush       bool
		membersStatus int
		wantErr       bool
		errSubstr     string
		// wantWarn is true when validation should pass but emit the
		// inconclusive-Members-scope advisory to its writer (fail-open branch).
		wantWarn bool
	}{
		{"valid read+write+members", http.StatusOK, true, http.StatusOK, false, "", false},
		{"read-only rejected", http.StatusOK, false, http.StatusOK, true, "lacks write access", false},
		{"revoked", http.StatusUnauthorized, false, 0, true, "invalid, expired, or revoked", false},
		{"no repo access", http.StatusNotFound, false, 0, true, "can't read", false},
		{"repo forbidden", http.StatusForbidden, false, 0, true, "can't read", false},
		{"members forbidden", http.StatusOK, true, http.StatusForbidden, true, "can't read the org's members", false},
		{"members not found", http.StatusOK, true, http.StatusNotFound, true, "can't read the org's members", false},
		// FAIL-OPEN: a 401 or 5xx on the members probe (after a 200 repo read
		// that already proved the token live) is inconclusive, not fatal — the
		// probe must not reject a valid token on GitHub-side flakiness, but it
		// MUST warn so the teacher knows to run probe-token before relying on it.
		{"members unauthorized proceeds", http.StatusOK, true, http.StatusUnauthorized, false, "", true},
		{"members server error proceeds", http.StatusOK, true, http.StatusInternalServerError, false, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var sawRepo, sawMembers bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				// Validation first reads the config repo (GET
				// /repos/{org}/classroom50) to assert
				// permissions.push, then probes org members (GET
				// /orgs/{org}/members) for the Members: Read scope.
				case strings.HasSuffix(r.URL.Path, "/repos/cs50/classroom50"):
					sawRepo = true
					if tc.repoStatus == http.StatusOK {
						_, _ = w.Write([]byte(`{"permissions":{"push":` + boolJSON(tc.canPush) + `}}`))
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
				t.Fatalf("expected an error (repo=%d canPush=%v members=%d)", tc.repoStatus, tc.canPush, tc.membersStatus)
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
			// returns 200 with push access. On any earlier failure it
			// must NOT be hit (fail fast on the Contents check).
			wantMembersProbe := tc.repoStatus == http.StatusOK && tc.canPush
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
			// A Members-less token must be told to add Members: Read.
			if tc.repoStatus == http.StatusOK && tc.canPush &&
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

// TestProvisionServiceSecret_PutStatus pins the PUT status handling: the
// Actions-secret upload must succeed on 201 (created) and 204 (updated),
// and the new assertion must reject any other 2xx (e.g. a 200 that means
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
