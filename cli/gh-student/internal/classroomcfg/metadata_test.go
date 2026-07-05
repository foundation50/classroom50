package classroomcfg

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/foundation50/gh-student/internal/githubapi"
)

func TestRenderClassroomMetadata_Shape(t *testing.T) {
	// `.classroom50.yaml` carries identity (classroom + assignment) plus a
	// `source:` block (template repo). The runner derives config-repo
	// coordinates from the calling repo's org and the classroom slug at
	// workflow time, so no `config:` block is written here.
	cfg := Config{
		Classroom:  "cs-principles",
		Assignment: "hello",
		Source: &Source{
			Owner:  "cs50",
			Repo:   "hello-template",
			Branch: "main",
		},
	}
	out, err := Render(cfg)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}

	// String scalars must be double-quoted so YAML doesn't auto-type slugs
	// like "yes" or "2026".
	wantSubs := []string{
		`classroom: "cs-principles"`,
		`assignment: "hello"`,
		`owner: "cs50"`,
		`repo: "hello-template"`,
		`branch: "main"`,
	}
	for _, s := range wantSubs {
		if !strings.Contains(string(out), s) {
			t.Errorf("expected %q in rendered metadata, got:\n%s", s, out)
		}
	}

	// Block structure: each top-level key appears once at column 0.
	for _, key := range []string{"classroom:", "assignment:", "source:"} {
		if !strings.Contains(string(out), "\n"+key) && !strings.HasPrefix(string(out), key) {
			t.Errorf("missing top-level key %q in:\n%s", key, out)
		}
	}

	// `config:` and `autograde:` blocks are dropped; the runner no longer
	// reads them.
	for _, removed := range []string{"config:", "autograde:"} {
		if strings.Contains(string(out), removed) {
			t.Errorf("legacy key %q must not appear in rendered metadata, got:\n%s", removed, out)
		}
	}

	// Round-trip: yaml.Unmarshal must recover the original config.
	var round Config
	if err := yaml.Unmarshal(out, &round); err != nil {
		t.Fatalf("round-trip parse: %v", err)
	}
	if !reflect.DeepEqual(round, cfg) {
		t.Errorf("round-trip mismatch:\n got: %#v\nwant: %#v", round, cfg)
	}
}

func TestRenderClassroomMetadata_TemplateLessOmitsSource(t *testing.T) {
	// A template-less assignment carries no Source: the rendered
	// `.classroom50.yaml` must omit the `source:` block entirely and
	// round-trip back to nil Source.
	cfg := Config{Classroom: "cs-principles", Assignment: "solo"}
	out, err := Render(cfg)
	if err != nil {
		t.Fatalf("Render(template-less): %v", err)
	}
	if strings.Contains(string(out), "source:") {
		t.Errorf("rendered metadata must omit the source block for a template-less assignment, got:\n%s", out)
	}
	var round Config
	if err := yaml.Unmarshal(out, &round); err != nil {
		t.Fatalf("round-trip parse: %v", err)
	}
	if round.Source != nil {
		t.Errorf("round-tripped Source = %+v, want nil", round.Source)
	}
}

func TestRenderClassroomMetadata_PreservesNumericLookingSlugs(t *testing.T) {
	// Pins double-quoting: a numeric-looking classroom slug must not encode as
	// a YAML integer — downstream string compares against args would break.
	cfg := Config{
		Classroom:  "2026",
		Assignment: "hello",
		Source:     &Source{Owner: "cs50", Repo: "hello-template", Branch: "main"},
	}
	out, err := Render(cfg)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if !strings.Contains(string(out), `classroom: "2026"`) {
		t.Errorf("classroom should be double-quoted to preserve string type, got:\n%s", out)
	}
}

func TestRenderClassroomMetadata_V1IdentityRoundTrips(t *testing.T) {
	ownerID := int64(12345)
	srcOwnerID := int64(99)
	cfg := Config{
		Schema:     SchemaRepoConfigV1,
		Classroom:  "cs-principles",
		Assignment: "hello",
		Owner: &Identity{
			Username:   "alice",
			ID:         &ownerID,
			AcceptedAt: "2026-06-01T14:33:11Z",
		},
		Source: &Source{
			Owner:   "cs50",
			OwnerID: &srcOwnerID,
			Repo:    "hello-template",
			Branch:  "main",
		},
	}
	out, err := Render(cfg)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}

	for _, want := range []string{
		`schema: "classroom50/repo-config/v1"`,
		`username: "alice"`,
		`accepted_at: "2026-06-01T14:33:11Z"`,
	} {
		if !strings.Contains(string(out), want) {
			t.Errorf("expected %q in rendered metadata, got:\n%s", want, out)
		}
	}

	var round Config
	if err := yaml.Unmarshal(out, &round); err != nil {
		t.Fatalf("round-trip parse: %v", err)
	}
	if !reflect.DeepEqual(round, cfg) {
		t.Errorf("round-trip mismatch:\n got: %#v\nwant: %#v", round, cfg)
	}
}

func TestRenderClassroomMetadata_IDsRenderAsUnquotedNumbers(t *testing.T) {
	// id/owner_id must encode as YAML numbers (or null), never quoted
	// strings, so typed parses (the web GUI's reader) agree.
	ownerID := int64(12345)
	srcOwnerID := int64(99)
	withIDs := Config{
		Classroom:  "cs-principles",
		Assignment: "hello",
		Owner:      &Identity{Username: "alice", ID: &ownerID},
		Source:     &Source{Owner: "cs50", OwnerID: &srcOwnerID, Repo: "t", Branch: "main"},
	}
	out, err := Render(withIDs)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	body := string(out)
	if !strings.Contains(body, "id: 12345") || strings.Contains(body, `id: "12345"`) {
		t.Errorf("owner.id should render as an unquoted number, got:\n%s", body)
	}
	if !strings.Contains(body, "owner_id: 99") || strings.Contains(body, `owner_id: "99"`) {
		t.Errorf("source.owner_id should render as an unquoted number, got:\n%s", body)
	}

	// A nil id pointer renders as YAML null.
	nilID := Config{
		Classroom:  "cs-principles",
		Assignment: "hello",
		Owner:      &Identity{Username: "alice", ID: nil},
	}
	out, err = Render(nilID)
	if err != nil {
		t.Fatalf("Render(nil id): %v", err)
	}
	if !strings.Contains(string(out), "id: null") {
		t.Errorf("a nil owner.id should render as `id: null`, got:\n%s", out)
	}
}

func TestReadConfig_PreV1BodyParsesWithoutNewFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, MetadataPath)
	body := "classroom: \"cs-principles\"\nassignment: \"hello\"\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	cfg, err := ReadConfig(path)
	if err != nil {
		t.Fatalf("ReadConfig(pre-v1): %v", err)
	}
	if cfg.Schema != "" {
		t.Errorf("pre-v1 Schema = %q, want empty", cfg.Schema)
	}
	if cfg.Owner != nil {
		t.Errorf("pre-v1 Owner = %+v, want nil", cfg.Owner)
	}
}

func TestIsHTTPNotFound(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"direct 404 HTTPError", &githubapi.HTTPError{StatusCode: http.StatusNotFound}, true},
		{"direct 409 HTTPError", &githubapi.HTTPError{StatusCode: http.StatusConflict}, false},
		{
			name: "wrapped 404 HTTPError still resolves",
			err:  fmt.Errorf("GET something: %w", &githubapi.HTTPError{StatusCode: http.StatusNotFound}),
			want: true,
		},
		{"plain error", errors.New("network unreachable"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsHTTPNotFound(tc.err); got != tc.want {
				t.Fatalf("IsHTTPNotFound(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestValidateSecret(t *testing.T) {
	valid := []string{"abcd", "abc123", "dhkrm4ih", "zzzz9999"}
	for _, s := range valid {
		if err := ValidateSecret(s); err != nil {
			t.Errorf("ValidateSecret(%q) = %v, want nil", s, err)
		}
	}
	// Separators/uppercase/too-short are rejected so a bad --key can't become
	// an unsafe path segment; empty is rejected here (callers branch first).
	invalid := []string{"", "abc", "ABC123", "abc-123", "abc/123", "abc 123", "abc.123"}
	for _, s := range invalid {
		if err := ValidateSecret(s); err == nil {
			t.Errorf("ValidateSecret(%q) = nil, want error", s)
		}
	}
}
