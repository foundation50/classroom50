// Package configrepo is the read substrate for the per-org <org>/classroom50
// config repo: contents/tree read helpers, the classroom-metadata and roster
// record types, and the team service. The write helpers live in
// internal/configwrite; neither imports the other.
package configrepo

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/ghutil"
	"github.com/foundation50/gh-teacher/internal/cliutil"
	"github.com/foundation50/gh-teacher/internal/githubapi"
)

// ConfigRepoName is the per-org config repository name (<org>/classroom50).
// Thin alias for the shared contract constant — the single source of truth.
const ConfigRepoName = contract.ConfigRepoName

// ContentEntry is one immediate child from the contents API for a directory.
// Type is "file" or "dir" (symlink/submodule are ignored).
type ContentEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Type string `json:"type"`
	SHA  string `json:"sha"`
}

// ReadFileContents reads path at ref and decodes the contents API's
// base64 envelope. (nil, false, nil) on missing path. For payloads near
// or over the contents API's 1MB ceiling, use the git-blobs API instead.
func ReadFileContents(client githubapi.Client, owner, repo, path, ref string) ([]byte, bool, error) {
	segs := strings.Split(path, "/")
	for i := range segs {
		segs[i] = url.PathEscape(segs[i])
	}
	apiPath := fmt.Sprintf("repos/%s/%s/contents/%s?ref=%s",
		url.PathEscape(owner), url.PathEscape(repo),
		strings.Join(segs, "/"), url.PathEscape(ref))
	var resp struct {
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}
	if err := client.Get(apiPath, &resp); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("GET %s: %w", apiPath, err)
	}
	if resp.Encoding != "base64" {
		return nil, false, fmt.Errorf("GET %s: unexpected encoding %q (expected base64)", apiPath, resp.Encoding)
	}
	data, err := ghutil.DecodeContentsBase64(resp.Content)
	if err != nil {
		return nil, false, fmt.Errorf("GET %s: decode base64: %w", apiPath, err)
	}
	return data, true, nil
}

// ContentsExists reports whether path exists at ref via a contents GET.
// Distinguishes a real 404 (false, nil) from a transport error.
func ContentsExists(client githubapi.Client, owner, repo, path, ref string) (bool, error) {
	segs := strings.Split(path, "/")
	for i := range segs {
		segs[i] = url.PathEscape(segs[i])
	}
	apiPath := fmt.Sprintf("repos/%s/%s/contents/%s?ref=%s",
		url.PathEscape(owner), url.PathEscape(repo),
		strings.Join(segs, "/"), url.PathEscape(ref))
	if err := client.Get(apiPath, nil); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return false, nil
		}
		return false, fmt.Errorf("GET %s: %w", apiPath, err)
	}
	return true, nil
}

// ListDirContents lists the immediate children of directory path at ref. Empty
// path lists the repo root. (nil, false, nil) on 404. Callers must pass only
// directory paths (a file path returns a JSON object and fails to decode).
func ListDirContents(client githubapi.Client, owner, repo, path, ref string) ([]ContentEntry, bool, error) {
	apiPath := contentsAPIPath(owner, repo, path, ref)
	var entries []ContentEntry
	if err := client.Get(apiPath, &entries); err != nil {
		if cliutil.IsHTTPStatus(err, http.StatusNotFound) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("GET %s: %w", apiPath, err)
	}
	return entries, true, nil
}

// contentsAPIPath builds the contents endpoint, percent-escaping each
// path segment. An empty path targets the repo root.
func contentsAPIPath(owner, repo, path, ref string) string {
	base := fmt.Sprintf("repos/%s/%s/contents", url.PathEscape(owner), url.PathEscape(repo))
	if path != "" {
		segs := strings.Split(path, "/")
		for i := range segs {
			segs[i] = url.PathEscape(segs[i])
		}
		base += "/" + strings.Join(segs, "/")
	}
	return base + "?ref=" + url.PathEscape(ref)
}

// CommitTreeSHA returns the tree SHA of commit commitSHA.
func CommitTreeSHA(client githubapi.Client, owner, repo, commitSHA string) (string, error) {
	path := fmt.Sprintf("repos/%s/%s/git/commits/%s",
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(commitSHA))
	var resp struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	if err := client.Get(path, &resp); err != nil {
		return "", fmt.Errorf("GET %s: %w", path, err)
	}
	return resp.Tree.SHA, nil
}

// ListSubtreeBlobPaths returns every blob path strictly under prefix (a
// repo-root-relative directory, no trailing slash) in the tree of
// commitSHA, using the git Trees API with recursive=1 (one call). Only
// blobs are returned. Errors if the tree response is truncated, since a
// partial list would under-delete the subtree.
func ListSubtreeBlobPaths(client githubapi.Client, owner, repo, commitSHA, prefix string) ([]string, error) {
	treeSHA, err := CommitTreeSHA(client, owner, repo, commitSHA)
	if err != nil {
		return nil, err
	}
	path := fmt.Sprintf("repos/%s/%s/git/trees/%s?recursive=1",
		url.PathEscape(owner), url.PathEscape(repo), url.PathEscape(treeSHA))
	var resp struct {
		Tree []struct {
			Path string `json:"path"`
			Type string `json:"type"`
		} `json:"tree"`
		Truncated bool `json:"truncated"`
	}
	if err := client.Get(path, &resp); err != nil {
		return nil, fmt.Errorf("GET %s: %w", path, err)
	}
	if resp.Truncated {
		return nil, fmt.Errorf("GET %s: tree listing truncated — too many files to enumerate the %q subtree safely", path, prefix)
	}
	want := prefix + "/"
	var paths []string
	for _, e := range resp.Tree {
		if e.Type != "blob" {
			continue
		}
		if strings.HasPrefix(e.Path, want) {
			paths = append(paths, e.Path)
		}
	}
	return paths, nil
}
