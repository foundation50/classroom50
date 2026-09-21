package download

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// botUser is the workflow token's identity on a release and its assets; any
// other login marks the release.
var botUser = map[string]any{"login": contract.AutogradeReleaseAuthor}

// botAsset is an asset the workflow token uploaded.
func botAsset(name, url string) map[string]any {
	return map[string]any{"name": name, "url": url, "uploader": botUser}
}

// botRelease is a submit/* release exactly as the runner publishes it.
func botRelease(tag string, assets ...map[string]any) map[string]any {
	if assets == nil {
		assets = []map[string]any{}
	}
	return map[string]any{"tag_name": tag, "author": botUser, "assets": assets}
}

func TestSelectResultAsset(t *testing.T) {
	cases := []struct {
		name        string
		rel         release
		wantURL     string
		wantErrPart string
	}{
		{
			name: "single result.json asset",
			rel: release{
				TagName: "submit/2026-06-01T14-32-05Z",
				Assets: []releaseAsset{
					{Name: "result.json", URL: "https://api.github.com/repos/o/r/releases/assets/1"},
				},
			},
			wantURL: "https://api.github.com/repos/o/r/releases/assets/1",
		},
		{
			name: "case-insensitive name match",
			rel: release{
				Assets: []releaseAsset{
					{Name: "RESULT.JSON", URL: "https://example/assets/2"},
				},
			},
			wantURL: "https://example/assets/2",
		},
		{
			name:    "no result.json asset returns empty (not an error)",
			rel:     release{Assets: []releaseAsset{{Name: "other.zip", URL: "x"}}},
			wantURL: "",
		},
		{
			name:    "empty assets list returns empty",
			rel:     release{Assets: nil},
			wantURL: "",
		},
		{
			name: "duplicate result.json assets reject ambiguity",
			rel: release{
				Assets: []releaseAsset{
					{Name: "result.json", URL: "a"},
					{Name: "result.json", URL: "b"},
				},
			},
			wantErrPart: "2 result.json assets",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := selectResultAsset(tc.rel)
			if tc.wantErrPart != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tc.wantErrPart)
				}
				if !strings.Contains(err.Error(), tc.wantErrPart) {
					t.Fatalf("err = %q, want substring %q", err.Error(), tc.wantErrPart)
				}
				return
			}
			if err != nil {
				t.Fatalf("selectResultAsset: %v", err)
			}
			if got != tc.wantURL {
				t.Fatalf("selectResultAsset = %q, want %q", got, tc.wantURL)
			}
		})
	}
}

// The Go check must accept nothing the runner's sniff clears, or a staged
// release_assets file renamed to result.json becomes a score. The cases live in
// cli/shared/testdata so the runner and collector run the same bytes
// (test_contract_parity.py); here the Go reader must reach the shared verdict.
func TestIsResultDocument_SharedFixtures(t *testing.T) {
	var doc struct {
		Cases []struct {
			Name             string `json:"name"`
			BodyBase64       string `json:"body_base64"`
			IsResultDocument bool   `json:"is_result_document"`
		} `json:"cases"`
	}
	readSharedFixture(t, "result_document_sniff_cases.json", &doc)
	if len(doc.Cases) == 0 {
		t.Fatal("no cases in fixture")
	}
	for _, tc := range doc.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			body, err := base64.StdEncoding.DecodeString(tc.BodyBase64)
			if err != nil {
				t.Fatalf("decode body: %v", err)
			}
			if got := isResultDocument(body); got != tc.IsResultDocument {
				t.Errorf("isResultDocument(%q) = %v, want %v", body, got, tc.IsResultDocument)
			}
		})
	}
}

// The three provenance readers must reach one verdict per release, and Go and
// Python must store the same message so scores.json and results.json agree.
func TestReleaseProvenanceProblem_SharedFixtures(t *testing.T) {
	var doc struct {
		Cases []struct {
			Name    string  `json:"name"`
			Release release `json:"release"`
			Problem *struct {
				Message string `json:"message"`
			} `json:"problem"`
		} `json:"cases"`
	}
	readSharedFixture(t, "release_provenance_cases.json", &doc)
	if len(doc.Cases) == 0 {
		t.Fatal("no cases in fixture")
	}
	for _, tc := range doc.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			want := ""
			if tc.Problem != nil {
				want = tc.Problem.Message
			}
			if got := releaseProvenanceProblem(tc.Release); got != want {
				t.Errorf("releaseProvenanceProblem = %q, want %q", got, want)
			}
		})
	}
}

// readSharedFixture decodes a cross-language golden fixture from
// cli/shared/testdata, the same file the Python and web mirrors run.
func readSharedFixture(t *testing.T, name string, into any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "testdata", name))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("decode fixture %s: %v", name, err)
	}
}

func TestListAllSubmitReleases(t *testing.T) {
	t.Run("returns every submit-tag release newest-first, filtering non-submit", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/r/releases", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode([]map[string]any{
				botRelease("submit/2026-06-03T10-00-00Z"),
				{"tag_name": "v2.0.0"},
				botRelease("submit/2026-06-02T10-00-00Z"),
				botRelease("submit/2026-06-01T10-00-00Z"),
			})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		rels, err := listAllSubmitReleases(client, "o", "r")
		if err != nil {
			t.Fatalf("listAllSubmitReleases: %v", err)
		}
		gotTags := make([]string, len(rels))
		for i, rel := range rels {
			gotTags[i] = rel.TagName
		}
		want := []string{
			"submit/2026-06-03T10-00-00Z",
			"submit/2026-06-02T10-00-00Z",
			"submit/2026-06-01T10-00-00Z",
		}
		if strings.Join(gotTags, ",") != strings.Join(want, ",") {
			t.Fatalf("tags = %v, want %v", gotTags, want)
		}
	})

	// A hand-made release or a clobbered result.json carries the student's login
	// as author or uploader. The listing keeps them all; the verdicts themselves
	// are pinned by TestReleaseProvenanceProblem_SharedFixtures.
	t.Run("keeps releases the workflow didn't publish", func(t *testing.T) {
		alice := map[string]any{"login": "alice"}
		forgedRelease := botRelease("submit/2026-06-02T10-00-00Z", botAsset("result.json", "u"))
		forgedRelease["author"] = alice
		replacedAsset := botRelease("submit/2026-06-01T10-00-00Z",
			map[string]any{"name": "result.json", "url": "u", "uploader": alice})
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/r/releases", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode([]map[string]any{forgedRelease, replacedAsset})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		rels, err := listAllSubmitReleases(client, "o", "r")
		if err != nil {
			t.Fatalf("listAllSubmitReleases: %v", err)
		}
		if len(rels) != 2 {
			t.Fatalf("kept %d releases, want both", len(rels))
		}
	})

	// A read-write token also lists drafts; the runner never publishes one, so a
	// draft submit/* tag is hand-made noise the collector skips too.
	t.Run("skips draft releases", func(t *testing.T) {
		draft := botRelease("submit/2026-06-02T10-00-00Z")
		draft["draft"] = true
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/r/releases", func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewEncoder(w).Encode([]map[string]any{draft, botRelease("submit/2026-06-01T10-00-00Z")})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		rels, err := listAllSubmitReleases(client, "o", "r")
		if err != nil {
			t.Fatalf("listAllSubmitReleases: %v", err)
		}
		if len(rels) != 1 || rels[0].TagName != "submit/2026-06-01T10-00-00Z" {
			t.Fatalf("kept %+v, want only the published release", rels)
		}
	})

	t.Run("404 → empty, not an error", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/missing/releases", func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		rels, err := listAllSubmitReleases(client, "o", "missing")
		if err != nil {
			t.Fatalf("listAllSubmitReleases: %v", err)
		}
		if len(rels) != 0 {
			t.Fatalf("got %d releases, want 0", len(rels))
		}
	})

	t.Run("paginates across pages", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/repos/o/many/releases", func(w http.ResponseWriter, r *http.Request) {
			page := r.URL.Query().Get("page")
			if page == "1" {
				batch := make([]map[string]any, allReleasesPerPage)
				for i := range batch {
					batch[i] = botRelease(fmt.Sprintf("submit/p1-%d", i))
				}
				_ = json.NewEncoder(w).Encode(batch)
				return
			}
			_ = json.NewEncoder(w).Encode([]map[string]any{botRelease("submit/last")})
		})
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		client := githubtest.NewTestClient(t, server)

		rels, err := listAllSubmitReleases(client, "o", "many")
		if err != nil {
			t.Fatalf("listAllSubmitReleases: %v", err)
		}
		if len(rels) != allReleasesPerPage+1 {
			t.Fatalf("got %d releases, want %d", len(rels), allReleasesPerPage+1)
		}
		if rels[len(rels)-1].TagName != "submit/last" {
			t.Errorf("last tag = %q, want submit/last", rels[len(rels)-1].TagName)
		}
	})
}
