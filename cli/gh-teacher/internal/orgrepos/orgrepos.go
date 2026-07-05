// Package orgrepos is the shared org-repository lister: a paginated walk of GET
// /orgs/{org}/repos returning every repo name. Consumed by download
// (pattern mode) and teardown (wildcard nuke), each of which filters the list
// itself.
package orgrepos

import (
	"fmt"
	"net/url"

	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// perPage / pagesMax bound the org-repos walk. 100×100 = 10k, far above
// classroom scale; hitting the cap errors loudly rather than under-reporting.
const (
	perPage  = 100
	pagesMax = 100
)

// ListNames returns every repo name in the org. Shared by download (pattern
// mode) and teardown (wildcard nuke), which filter it themselves.
func ListNames(client githubapi.Client, org string) ([]string, error) {
	repos, err := githubapi.PaginateAll[struct {
		Name string `json:"name"`
	}](client, perPage, pagesMax,
		func(page int) string {
			return fmt.Sprintf("orgs/%s/repos?per_page=%d&page=%d", url.PathEscape(org), perPage, page)
		}, nil)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(repos))
	for _, r := range repos {
		names = append(names, r.Name)
	}
	return names, nil
}
