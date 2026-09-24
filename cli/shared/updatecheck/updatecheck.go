// Package updatecheck answers "is this binary behind the latest release?" on
// demand. It is deliberately not a notifier: gh itself (>= 2.62) already tells
// users about extension updates once a day. This runs only after a command has
// failed on a config value the binary does not know, so the hedged "if a newer
// client wrote this value" can become a definite "you have v1.40.0 and v1.55.0
// is available" (or "you are current, so the value itself is wrong").
package updatecheck

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
)

// stale marks an error whose likely cause is a binary older than the config it
// read. It is the only signal main uses to decide the lookup is worth a
// round-trip.
type stale struct{ err error }

func (e *stale) Error() string { return e.err.Error() }
func (e *stale) Unwrap() error { return e.err }

// Mark flags err as probably caused by a stale binary. The message is left
// untouched; the mark survives %w wrapping.
func Mark(err error) error { return &stale{err: err} }

// MaybeStale reports whether err, or anything it wraps, was Marked.
func MaybeStale(err error) bool {
	_, ok := errors.AsType[*stale](err)
	return ok
}

// defaultAPIBase is where releases are looked up. Extension repos live on
// github.com even for GHES users, so this is not the user's configured host.
const defaultAPIBase = "https://api.github.com"

// timeout bounds the lookup: it runs on a failure path the user is already
// waiting on, and a slow answer is worth less than a fast exit.
const timeout = 3 * time.Second

// Options identifies the running binary and where its releases are published.
type Options struct {
	// Repo is "owner/name" of the standalone extension repo; its base name is
	// the binary name.
	Repo string
	// Current is the running version as stamped by ldflags ("v1.40.0"), or
	// "dev" for a source build.
	Current string
	// APIBase overrides defaultAPIBase (tests).
	APIBase string
}

// Advice is the whole failure-path flow: empty unless err is Marked and the
// lookup is conclusive, otherwise the definite follow-up line to the hedged
// hint. ifCurrent is the caller's next step when upgrading cannot help, since
// that differs per CLI.
func Advice(ctx context.Context, err error, opts Options, ifCurrent string) string {
	if !MaybeStale(err) {
		return ""
	}
	res, ok := compareRelease(ctx, opts)
	if !ok {
		return ""
	}
	name := path.Base(opts.Repo)
	if res.behind {
		return fmt.Sprintf("%s: you have %s and %s is available. Run `gh extension upgrade %s`, then retry", name, res.current, res.latest, opts.Repo)
	}
	return fmt.Sprintf("%s: you already have the latest release (%s), so upgrading will not help. %s", name, res.current, ifCurrent)
}

type result struct {
	current, latest string
	behind          bool
}

// compareRelease looks up the newest non-prerelease of opts.Repo and compares
// it to opts.Current. ok is false whenever nothing definite can be said: a
// source build, an unparseable tag, no network, or a binary ahead of the
// latest release (a deploy window or a prerelease), so callers print a line or
// stay quiet, never guess.
func compareRelease(ctx context.Context, opts Options) (result, bool) {
	current, ok := parseVersion(opts.Current)
	if !ok {
		return result{}, false
	}
	tag, err := latestTag(ctx, opts)
	if err != nil {
		return result{}, false
	}
	latest, ok := parseVersion(tag)
	if !ok {
		return result{}, false
	}
	order := current.compare(latest)
	if order > 0 {
		return result{}, false
	}
	return result{current: current.String(), latest: latest.String(), behind: order < 0}, true
}

func latestTag(ctx context.Context, opts Options) (string, error) {
	base := cmp.Or(opts.APIBase, defaultAPIBase)
	url := fmt.Sprintf("%s/repos/%s/releases/latest", strings.TrimRight(base, "/"), opts.Repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", path.Base(opts.Repo)+"/"+opts.Current)
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("releases/latest: HTTP %d", resp.StatusCode)
	}
	var release struct {
		TagName string `json:"tag_name"`
	}
	// Only tag_name is needed; the cap keeps a misbehaving proxy from turning
	// the 3s time bound into an unbounded read.
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&release); err != nil {
		return "", err
	}
	if release.TagName == "" {
		return "", errors.New("releases/latest: empty tag_name")
	}
	return release.TagName, nil
}

// version is the vMAJOR.MINOR.PATCH[-prerelease] shape cli-release.yaml
// enforces on every tag it stamps into ldflags and publishes.
type version struct {
	major, minor, patch int
	prerelease          string
}

func parseVersion(s string) (version, bool) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	core, prerelease, _ := strings.Cut(s, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return version{}, false
	}
	var nums [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || strconv.Itoa(n) != p {
			return version{}, false
		}
		nums[i] = n
	}
	return version{major: nums[0], minor: nums[1], patch: nums[2], prerelease: prerelease}, true
}

// compare orders by core, then treats a prerelease as older than the release
// with the same core (semver). Two prereleases of the same core are equal here;
// releases/latest never returns one, so the finer ordering is not needed.
func (v version) compare(o version) int {
	if c := cmp.Or(cmp.Compare(v.major, o.major), cmp.Compare(v.minor, o.minor), cmp.Compare(v.patch, o.patch)); c != 0 {
		return c
	}
	switch {
	case v.prerelease != "" && o.prerelease == "":
		return -1
	case v.prerelease == "" && o.prerelease != "":
		return 1
	}
	return 0
}

func (v version) String() string {
	s := fmt.Sprintf("v%d.%d.%d", v.major, v.minor, v.patch)
	if v.prerelease != "" {
		s += "-" + v.prerelease
	}
	return s
}
