package githubapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/foundation50/classroom50-cli-shared/ghutil"
)

// PaginateAll walks a GitHub `page`/`per_page` list endpoint, returning every
// element across pages. The shared core for the teacher CLI's capped list
// walks, replacing hand-rolled loops.
//
//   - pageURL(page) builds the path for a 1-based page (callers own
//     per_page/page formatting). Only page 1 is built from pageURL; subsequent
//     pages follow the server's `Link: rel="next"`. Without a Link header, the
//     walk synthesizes the next page via pageURL and stops on a short page.
//   - onErr maps a failed request to a caller-specific error; nil wraps as
//     `GET <path>`.
//   - Termination: no `rel="next"`, or (no Link header) a short page. Hitting
//     maxPages is a safety-cap error, since a partial list would under-report.
func PaginateAll[T any](
	client Client,
	perPage, maxPages int,
	pageURL func(page int) string,
	onErr func(path string, err error) error,
) ([]T, error) {
	var all []T
	path := pageURL(1)
	for page := 1; page <= maxPages; page++ {
		batch, linkHeader, err := GetPage[T](client, path)
		if err != nil {
			if onErr != nil {
				return nil, onErr(path, err)
			}
			return nil, fmt.Errorf("GET %s: %w", path, err)
		}
		all = append(all, batch...)

		// Centralized termination via ghutil.NextPage (shared with the student
		// CLI) so the predicate can't drift: follow `rel="next"`; stop on a
		// no-next Link or a short no-Link page; else synthesize the next page.
		next, stop := ghutil.NextPage(linkHeader, len(batch), perPage)
		if stop {
			return all, nil
		}
		if next != "" {
			path = next
			continue
		}
		path = pageURL(page + 1)
	}
	return nil, fmt.Errorf("pagination hit the %d-page safety cap (>%d items) -- unexpected; retry or file an issue",
		maxPages, maxPages*perPage)
}

// GetPage issues one list request and returns the decoded batch plus the raw
// Link header. It uses Request (not Get) so the Link header is available for
// next-page resolution.
//
// Following the server's absolute `rel="next"` relies on go-gh's
// headerRoundTripper stripping Authorization on any host that isn't the
// configured API host (or a subdomain), so a crafted off-host next link can't
// pivot the token. (On GHES a sibling subdomain retains the token; accepted, as
// the API host is already the trust boundary.)
func GetPage[T any](client Client, path string) ([]T, string, error) {
	resp, err := client.Request(http.MethodGet, path, nil)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	var batch []T
	if err := json.NewDecoder(resp.Body).Decode(&batch); err != nil {
		return nil, "", fmt.Errorf("decode body: %w", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return batch, resp.Header.Get("Link"), nil
}
