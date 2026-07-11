package autograder

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/foundation50/gh-teacher/internal/githubtest"
)

func TestAutograderFilePath(t *testing.T) {
	// The path shape is part of two public contracts: the on-disk
	// layout (`<classroom>/autograders/<name>.yaml`) and the Pages
	// URL the student CLI builds against. Only non-default
	// autograders land as files in the config repo — `default`
	// resolves to the embedded gh-student shim instead — but
	// FilePath itself is a pure helper that should still
	// produce the same shape for any name.
	cases := []struct {
		classroom string
		name      string
		want      string
	}{
		{"cs-principles", "io-suite", "cs-principles/autograders/io-suite.yaml"},
		{"intro-java", "c-makefile", "intro-java/autograders/c-makefile.yaml"},
	}
	for _, tc := range cases {
		if got := FilePath(tc.classroom, tc.name); got != tc.want {
			t.Errorf("FilePath(%q, %q) = %q, want %q", tc.classroom, tc.name, got, tc.want)
		}
	}
}

func TestValidateAutograderName(t *testing.T) {
	cases := []struct {
		name    string
		wantErr bool
	}{
		// Valid — same alphabet as classroom short-names / assignment
		// slugs because both flow into the same paths.
		{"default", false},
		{"io-suite", false},
		{"python-pytest", false},
		{"cs50", false},

		// Empty → distinct error citing the default ("did you mean
		// --autograder default?").
		{"", true},

		// Path-traversal / separator attempts. Must not reach the
		// contents API.
		{"../secrets.txt", true},
		{"..", true},
		{"foo/bar", true},
		{".github", true},

		// Uppercase / disallowed punctuation.
		{"Default", true},
		{"io_suite", true},
		{"-foo", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateName(tc.name)
			if tc.wantErr && err == nil {
				t.Fatalf("ValidateName(%q) = nil, want error", tc.name)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("ValidateName(%q) = %v, want nil", tc.name, err)
			}
		})
	}
}

func TestValidateAutograderName_EmptyMentionsDefault(t *testing.T) {
	// The empty-input message is the only nudge a teacher gets when
	// they type `--autograder` with no value. It must name the
	// default so they can either accept it or pass the right thing.
	err := ValidateName("")
	if err == nil {
		t.Fatalf("expected error for empty name, got nil")
	}
	if !strings.Contains(err.Error(), defaultName) {
		t.Errorf("empty-name error should reference default %q, got %q", defaultName, err)
	}
}

func TestAutograderExists(t *testing.T) {
	// Pins the write-time existence probe `gh teacher assignment
	// add --autograder` relies on. A bug here (wrong path, wrong
	// status mapping) silently allows a typo'd autograder name to
	// land in assignments.json, which then 404s on every student's
	// accept — a class-wide failure surfacing only at use time.
	cases := []struct {
		name       string
		path       string // path the test server treats as existing
		queryName  string // autograder name passed to Exists
		wantExists bool
	}{
		{
			"existing default.yaml",
			"cs-principles/autograders/default.yaml",
			"default",
			true,
		},
		{
			"existing io-suite.yaml (sibling autograder)",
			"cs-principles/autograders/io-suite.yaml",
			"io-suite",
			true,
		},
		{
			"missing autograder returns false (not error)",
			"cs-principles/autograders/default.yaml",
			"missing",
			false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var (
				mu      sync.Mutex
				gotPath string
			)
			mux := http.NewServeMux()
			mux.HandleFunc("/repos/cs50/classroom50/contents/", func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				gotPath = strings.TrimPrefix(r.URL.Path, "/repos/cs50/classroom50/contents/")
				mu.Unlock()
				if gotPath == tc.path {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(`{"type":"file","content":"","encoding":"base64"}`))
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"message":"Not Found"}`))
			})

			server := httptest.NewServer(mux)
			t.Cleanup(server.Close)
			client := githubtest.NewTestClient(t, server)

			got, err := Exists(client, "cs50", "classroom50", "cs-principles", tc.queryName, "main")
			if err != nil {
				t.Fatalf("Exists: %v", err)
			}
			if got != tc.wantExists {
				t.Errorf("Exists = %v, want %v (path probed: %q)", got, tc.wantExists, gotPath)
			}
			// Confirm the path actually probed matches the
			// `<classroom>/autograders/<name>.yaml` contract — a
			// regression here would silently 404 every probe.
			wantProbed := "cs-principles/autograders/" + tc.queryName + ".yaml"
			if gotPath != wantProbed {
				t.Errorf("probed path %q, want %q (autograder URL contract drift)", gotPath, wantProbed)
			}
		})
	}
}
