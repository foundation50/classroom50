package classroomcfg

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/foundation50/gh-student/internal/githubapi"
)

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
