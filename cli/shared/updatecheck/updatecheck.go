// Package updatecheck answers "is this binary behind the latest release?" on
// demand. It is deliberately not a notifier: gh itself (>= 2.62) already tells
// users about extension updates once a day. This runs only after a command has
// failed on a config value the binary does not know, so the hedged "if a newer
// client wrote this value" can become a definite "you have v1.40.0 and v1.55.0
// is available" (or "you are current, so the value itself is wrong").
package updatecheck

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Stale is implemented by errors whose likely cause is a binary older than the
// config it read. It is the only signal main uses to decide the lookup is
// worth a round-trip.
type Stale interface {
	MaybeStale()
}

// MaybeStale reports whether err, or anything it wraps, implements Stale.
func MaybeStale(err error) bool {
	var s Stale
	return errors.As(err, &s)
}

// DefaultAPIBase is where releases are looked up. Extension repos live on
// github.com even for GHES users, so this is not the user's configured host.
const DefaultAPIBase = "https://api.github.com"

// Timeout bounds the lookup: it runs on a failure path the user is already
// waiting on, and a slow answer is worth less than a fast exit.
const Timeout = 3 * time.Second

// Options identifies the running binary and where its releases are published.
type Options struct {
	// Name is the binary name, e.g. "gh-teacher"; it becomes the User-Agent.
	Name string
	// Repo is "owner/name" of the standalone extension repo.
	Repo string
	// Current is the running version as stamped by ldflags ("v1.40.0"), or
	// "dev" for a source build.
	Current string
	// APIBase overrides DefaultAPIBase (tests).
	APIBase string
	// Client overrides the default http.Client (tests).
	Client *http.Client
}

// Result is a definite comparison between the running release and the latest.
type Result struct {
	Current string
	Latest  string
	Behind  bool
}

// Compare looks up the newest non-prerelease of opts.Repo and compares it to
// opts.Current. ok is false whenever nothing definite can be said: a source
// build, an unparseable tag, no network, or a binary ahead of the latest
// release (a deploy window or a prerelease), so callers print a line or stay
// quiet, never guess.
func Compare(ctx context.Context, opts Options) (Result, bool) {
	current, ok := parseVersion(opts.Current)
	if !ok {
		return Result{}, false
	}
	tag, err := latestTag(ctx, opts)
	if err != nil {
		return Result{}, false
	}
	latest, ok := parseVersion(tag)
	if !ok {
		return Result{}, false
	}
	switch cmp := current.compare(latest); {
	case cmp < 0:
		return Result{Current: current.String(), Latest: latest.String(), Behind: true}, true
	case cmp == 0:
		return Result{Current: current.String(), Latest: latest.String()}, true
	default:
		return Result{}, false
	}
}

// Advice is the whole failure-path flow: empty unless err carries the Stale
// marker and the lookup is conclusive, otherwise the definite follow-up line to
// the hedged hint. ifCurrent is the caller's next step when upgrading cannot
// help, since that differs per CLI.
func Advice(ctx context.Context, err error, opts Options, ifCurrent string) string {
	if !MaybeStale(err) {
		return ""
	}
	res, ok := Compare(ctx, opts)
	if !ok {
		return ""
	}
	if res.Behind {
		return fmt.Sprintf("%s: you have %s and %s is available. Run `gh extension upgrade %s`, then retry", opts.Name, res.Current, res.Latest, opts.Repo)
	}
	return fmt.Sprintf("%s: you already have the latest release (%s), so upgrading will not help. %s", opts.Name, res.Current, ifCurrent)
}

func latestTag(ctx context.Context, opts Options) (string, error) {
	base := opts.APIBase
	if base == "" {
		base = DefaultAPIBase
	}
	client := opts.Client
	if client == nil {
		client = &http.Client{Timeout: Timeout}
	}
	url := fmt.Sprintf("%s/repos/%s/releases/latest", strings.TrimRight(base, "/"), opts.Repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", opts.Name+"/"+opts.Current)
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
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
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
	for _, d := range []int{v.major - o.major, v.minor - o.minor, v.patch - o.patch} {
		if d != 0 {
			return d
		}
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
