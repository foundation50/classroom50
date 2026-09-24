package updatecheck

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMark(t *testing.T) {
	base := errors.New("invalid mode")
	marked := Mark(base)
	if marked.Error() != base.Error() {
		t.Errorf("Mark changed the message: %q", marked.Error())
	}
	if !errors.Is(marked, base) {
		t.Error("Mark must unwrap to the original error")
	}
	if !MaybeStale(fmt.Errorf("outer: %w", fmt.Errorf("inner: %w", marked))) {
		t.Error("MaybeStale should see through %w wrapping")
	}
	if MaybeStale(base) {
		t.Error("an unmarked error is not stale")
	}
	if MaybeStale(nil) {
		t.Error("nil is not stale")
	}
}

// newReleaseServer answers releases/latest with tag and counts hits so tests
// can assert the lookup is skipped entirely when it cannot be useful.
func newReleaseServer(t *testing.T, status int, body string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/repos/foundation50/gh-teacher/releases/latest" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if ua := r.Header.Get("User-Agent"); !strings.HasPrefix(ua, "gh-teacher/") {
			t.Errorf("User-Agent = %q, want gh-teacher/<version>", ua)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func testOptions(current, apiBase string) Options {
	return Options{Repo: "foundation50/gh-teacher", Current: current, APIBase: apiBase}
}

func TestCompareRelease(t *testing.T) {
	cases := []struct {
		name       string
		current    string
		status     int
		body       string
		wantOK     bool
		wantBehind bool
		wantHits   int32
	}{
		{name: "behind", current: "v1.40.0", status: 200, body: `{"tag_name":"v1.55.0"}`, wantOK: true, wantBehind: true, wantHits: 1},
		{name: "equal", current: "v1.55.0", status: 200, body: `{"tag_name":"v1.55.0"}`, wantOK: true, wantHits: 1},
		{name: "prerelease of the latest core is behind", current: "v1.55.0-rc.1", status: 200, body: `{"tag_name":"v1.55.0"}`, wantOK: true, wantBehind: true, wantHits: 1},
		{name: "ahead says nothing", current: "v1.56.0", status: 200, body: `{"tag_name":"v1.55.0"}`, wantHits: 1},
		{name: "dev build never calls out", current: "dev", status: 200, body: `{"tag_name":"v1.55.0"}`},
		{name: "not found", current: "v1.40.0", status: 404, body: `{"message":"Not Found"}`, wantHits: 1},
		{name: "rate limited", current: "v1.40.0", status: 403, body: `{}`, wantHits: 1},
		{name: "empty tag", current: "v1.40.0", status: 200, body: `{}`, wantHits: 1},
		{name: "garbage tag", current: "v1.40.0", status: 200, body: `{"tag_name":"latest"}`, wantHits: 1},
		{name: "garbage body", current: "v1.40.0", status: 200, body: `not json`, wantHits: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, hits := newReleaseServer(t, tc.status, tc.body)
			res, ok := compareRelease(context.Background(), testOptions(tc.current, srv.URL))
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (res %+v)", ok, tc.wantOK, res)
			}
			if ok && res.behind != tc.wantBehind {
				t.Errorf("behind = %v, want %v", res.behind, tc.wantBehind)
			}
			if hits.Load() != tc.wantHits {
				t.Errorf("server hits = %d, want %d", hits.Load(), tc.wantHits)
			}
		})
	}
}

func TestCompareRelease_NetworkFailureIsSilent(t *testing.T) {
	srv, _ := newReleaseServer(t, 200, `{"tag_name":"v1.55.0"}`)
	srv.Close()
	if _, ok := compareRelease(context.Background(), testOptions("v1.40.0", srv.URL)); ok {
		t.Error("a refused connection must not produce a verdict")
	}
}

func TestCompareRelease_HonorsContext(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
	}))
	t.Cleanup(func() { close(block); srv.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, ok := compareRelease(ctx, testOptions("v1.40.0", srv.URL)); ok {
		t.Error("a cancelled lookup must not produce a verdict")
	}
	if time.Since(start) > 2*time.Second {
		t.Error("lookup did not return on context cancellation")
	}
}

func TestAdvice(t *testing.T) {
	srv, hits := newReleaseServer(t, 200, `{"tag_name":"v1.55.0"}`)
	stale := fmt.Errorf("load: %w", Mark(errors.New("invalid mode")))

	got := Advice(context.Background(), stale, testOptions("v1.40.0", srv.URL), "unused")
	for _, want := range []string{"gh-teacher: you have v1.40.0", "v1.55.0", "gh extension upgrade foundation50/gh-teacher", "then retry"} {
		if !strings.Contains(got, want) {
			t.Errorf("behind advice %q lacks %q", got, want)
		}
	}

	got = Advice(context.Background(), stale, testOptions("v1.55.0", srv.URL), "Ask your teacher")
	if !strings.Contains(got, "latest release (v1.55.0)") || !strings.HasSuffix(got, "Ask your teacher") {
		t.Errorf("current advice = %q", got)
	}
	if strings.Contains(got, "gh extension upgrade") {
		t.Errorf("current advice must not tell the user to upgrade: %q", got)
	}

	if got := Advice(context.Background(), stale, testOptions("dev", srv.URL), "x"); got != "" {
		t.Errorf("dev build advice = %q, want none", got)
	}

	before := hits.Load()
	if got := Advice(context.Background(), errors.New("plain"), testOptions("v1.40.0", srv.URL), "x"); got != "" {
		t.Errorf("plain error advice = %q, want none", got)
	}
	if hits.Load() != before {
		t.Error("an unmarked error must not trigger a lookup")
	}
}

func TestParseVersion(t *testing.T) {
	cases := []struct {
		in   string
		ok   bool
		want string
	}{
		{"v1.55.0", true, "v1.55.0"},
		{"1.55.0", true, "v1.55.0"},
		{" v1.55.0\n", true, "v1.55.0"},
		{"v1.56.0-rc.1", true, "v1.56.0-rc.1"},
		{"dev", false, ""},
		{"v1.55", false, ""},
		{"v1.55.0.1", false, ""},
		{"v1.055.0", false, ""},
		{"v1.-5.0", false, ""},
		{"cli-v1.55.0", false, ""},
		{"", false, ""},
	}
	for _, tc := range cases {
		v, ok := parseVersion(tc.in)
		if ok != tc.ok {
			t.Errorf("parseVersion(%q) ok = %v, want %v", tc.in, ok, tc.ok)
			continue
		}
		if ok && v.String() != tc.want {
			t.Errorf("parseVersion(%q) = %q, want %q", tc.in, v.String(), tc.want)
		}
	}
}

func TestVersionCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"v1.0.0", "v1.0.0", 0},
		{"v1.0.0", "v1.0.1", -1},
		{"v1.9.0", "v1.10.0", -1},
		{"v2.0.0", "v1.99.99", 1},
		{"v1.0.0-rc.1", "v1.0.0", -1},
		{"v1.0.0", "v1.0.0-rc.1", 1},
		{"v1.0.0-rc.1", "v1.0.0-rc.2", 0},
		{"v1.0.1-rc.1", "v1.0.0", 1},
	}
	for _, tc := range cases {
		a, _ := parseVersion(tc.a)
		b, _ := parseVersion(tc.b)
		if got := a.compare(b); got != tc.want {
			t.Errorf("compare(%s, %s) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}
