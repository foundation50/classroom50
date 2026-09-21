// Reading a repo's submit/* releases. The release shapes, the provenance
// judgment, and the result-document sniff are hand-mirrored in collect_scores.py
// and the web (releaseRunReads.ts); the shared fixtures under cli/shared/testdata
// pin all three.

package download

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// release / releaseAsset: only the fields download consumes. Other keys are
// absent so a malformed release doesn't fail decode for a key we don't use.
type release struct {
	TagName string         `json:"tag_name"`
	Draft   bool           `json:"draft"`
	Author  releaseUser    `json:"author"`
	Assets  []releaseAsset `json:"assets"`
}

type releaseAsset struct {
	Name     string      `json:"name"`
	URL      string      `json:"url"`
	Uploader releaseUser `json:"uploader"`
}

type releaseUser struct {
	Login string `json:"login"`
}

// releaseProvenanceProblem says why a submit/* release did not come from the autograde
// workflow, or "" when it did. Students can write to their repos, so they can
// publish a release or replace its result.json as themselves. They can't act as
// the workflow's GITHUB_TOKEN, so the author and every result.json uploader must
// be that login; a missing one counts as someone else. The reason is recorded
// beside the result rather than used to drop it, since a teacher may publish by
// hand. Mirrors release_provenance_problem in collect_scores.py.
func releaseProvenanceProblem(rel release) string {
	describe := func(login string) string {
		if login == "" {
			return "an unknown account"
		}
		return login
	}
	// Single quotes match collect_scores.py's repr() so the same release reads
	// identically in scores.json and results.json.
	if rel.Author.Login != contract.AutogradeReleaseAuthor {
		return fmt.Sprintf("published by '%s', not by the autograde workflow", describe(rel.Author.Login))
	}
	for _, a := range rel.Assets {
		if !isResultAsset(a) {
			continue
		}
		if a.Uploader.Login != contract.AutogradeReleaseAuthor {
			return fmt.Sprintf("%s uploaded by '%s', not by the autograde workflow",
				resultAssetName, describe(a.Uploader.Login))
		}
	}
	return ""
}

// isResultDocument reports whether body is a classroom50/result/v1 document by
// its schema sentinel alone; full validation is the collector's job. It must
// accept no more than the runner's _looks_like_result_document refuses, or a
// student could stage a file the sniff clears and rename it to result.json:
// encoding/json matches struct keys case-insensitively, tolerates invalid UTF-8
// in strings, and reads integer literals of any length, where json.loads does
// none of those, so all three are checked by hand.
func isResultDocument(body []byte) bool {
	if !utf8.Valid(body) {
		return false
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(body, &doc) != nil {
		return false
	}
	var schema string
	if json.Unmarshal(doc["schema"], &schema) != nil || schema != contract.ResultSchemaV1 {
		return false
	}
	return !hasOversizedInt(body)
}

// maxJSONIntDigits mirrors Python's default int/str conversion limit
// (sys.get_int_max_str_digits), past which json.loads raises ValueError on an
// integer literal. Floats and exponents are unbounded there too.
const maxJSONIntDigits = 4300

// hasOversizedInt reports whether any integer literal in body exceeds
// maxJSONIntDigits. Decoded with UseNumber so every literal is seen verbatim.
func hasOversizedInt(body []byte) bool {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if dec.Decode(&v) != nil {
		return false
	}
	var walk func(any) bool
	walk = func(v any) bool {
		switch x := v.(type) {
		case json.Number:
			s := strings.TrimPrefix(string(x), "-")
			return !strings.ContainsAny(s, ".eE") && len(s) > maxJSONIntDigits
		case map[string]any:
			for _, e := range x {
				if walk(e) {
					return true
				}
			}
		case []any:
			for _, e := range x {
				if walk(e) {
					return true
				}
			}
		}
		return false
	}
	return walk(v)
}

// isResultAsset matches the release asset that carries the score. Case-folded
// like the collector's `.lower()` compare.
func isResultAsset(a releaseAsset) bool {
	return strings.EqualFold(a.Name, resultAssetName)
}

// listAllSubmitReleases returns every submit-tag release for a repo, newest
// first, walking the full /releases pagination. Non-submit releases (a
// student's hand-created tag) and drafts (the runner never publishes one, and a
// draft's assets aren't downloadable) are filtered out. Mirrors
// all_submit_releases in collect_scores.py.
func listAllSubmitReleases(client githubapi.Client, owner, repo string) ([]release, error) {
	all, err := githubapi.PaginateAll[release](client, allReleasesPerPage, allReleasesPagesMax,
		func(page int) string {
			return fmt.Sprintf("repos/%s/%s/releases?per_page=%d&page=%d",
				url.PathEscape(owner), url.PathEscape(repo), allReleasesPerPage, page)
		}, func(path string, err error) error {
			// A repo with no releases (or not accepted yet) 404s; treat as "no
			// submissions" rather than a hard failure.
			if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
				return errNoReleases
			}
			return fmt.Errorf("GET %s: %w", path, err)
		})
	if errors.Is(err, errNoReleases) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	submits := make([]release, 0, len(all))
	for _, rel := range all {
		if strings.HasPrefix(rel.TagName, submitTagPrefix) && !rel.Draft {
			submits = append(submits, rel)
		}
	}
	return submits, nil
}

// errNoReleases signals a 404 on the releases walk so listAllSubmitReleases can
// map it to an empty result instead of a hard error.
var errNoReleases = errors.New("no releases")

// selectResultAsset returns the result.json asset URL. Empty when absent; error
// when the release carries more than one (matches collect_scores.py's ambiguity
// rejection — uploads use --clobber, so normal releases have exactly one).
func selectResultAsset(rel release) (string, error) {
	var matches []string
	for _, a := range rel.Assets {
		if isResultAsset(a) {
			matches = append(matches, a.URL)
		}
	}
	switch len(matches) {
	case 0:
		return "", nil
	case 1:
		return matches[0], nil
	default:
		return "", fmt.Errorf("release has %d %s assets (expected exactly one)", len(matches), resultAssetName)
	}
}

// apiBaseURL returns the REST base URL for `host`, matching go-gh's routing.
// github.com → https://api.github.com; everything else assumed GHES at
// https://<host>/api/v3.
func apiBaseURL(host string) string {
	host = strings.TrimSpace(host)
	if host == "" || host == "github.com" {
		return "https://api.github.com"
	}
	return "https://" + host + "/api/v3"
}
