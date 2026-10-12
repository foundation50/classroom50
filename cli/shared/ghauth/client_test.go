package ghauth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/api"
)

func TestWithDeadlineTransport(t *testing.T) {
	got := withDeadlineTransport(api.ClientOptions{})
	dt, ok := got.Transport.(*deadlineTransport)
	if !ok || dt.fallback != RequestTimeout || dt.ceiling != RequestCeiling {
		t.Fatalf("Transport = %#v, want the %v default under a %v ceiling", got.Transport, RequestTimeout, RequestCeiling)
	}
	if got.Timeout != 0 {
		t.Fatalf("Timeout = %v, want the bounds to live in the transport, not http.Client.Timeout", got.Timeout)
	}
	if RequestTimeout >= RequestCeiling {
		t.Fatalf("RequestTimeout %v must stay below RequestCeiling %v", RequestTimeout, RequestCeiling)
	}

	// A per-client Timeout keeps its meaning as the default for requests
	// without a deadline, and never reaches http.Client.Timeout, which would
	// put a deadline on every request and defeat the fallback.
	got = withDeadlineTransport(api.ClientOptions{Timeout: time.Second})
	dt, ok = got.Transport.(*deadlineTransport)
	if !ok || dt.fallback != time.Second {
		t.Fatalf("Transport = %#v, want a 1s fallback", got.Transport)
	}
	if got.Timeout != 0 {
		t.Fatalf("Timeout = %v, want it cleared once folded into the fallback", got.Timeout)
	}

	// A caller-supplied Transport is wrapped, not replaced.
	inner := &hostRewriteTransport{}
	got = withDeadlineTransport(api.ClientOptions{Transport: inner})
	if dt, ok = got.Transport.(*deadlineTransport); !ok || dt.next != inner {
		t.Fatalf("Transport = %#v, want deadlineTransport wrapping the caller's transport", got.Transport)
	}
}

// stalledServer accepts a connection and never answers, so only a deadline
// can end the request.
func stalledServer(t *testing.T) *url.URL {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)
	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	return u
}

func stalledClient(t *testing.T, fallback, ceiling time.Duration) *api.RESTClient {
	t.Helper()
	client, err := api.NewRESTClient(api.ClientOptions{
		Host:         "github.com",
		AuthToken:    "test-token",
		Transport:    &deadlineTransport{next: &hostRewriteTransport{target: stalledServer(t)}, fallback: fallback, ceiling: ceiling},
		LogIgnoreEnv: true,
	})
	if err != nil {
		t.Fatalf("NewRESTClient: %v", err)
	}
	return client
}

// A request without a deadline of its own fails at the fallback: the plain
// verbs the CLIs use everywhere stay bounded exactly as before.
func TestDeadlineTransport_FallbackEndsStalledRequest(t *testing.T) {
	client := stalledClient(t, 50*time.Millisecond, RequestCeiling)
	start := time.Now()
	if err := client.Get("user", nil); err == nil {
		t.Fatal("expected a timeout error against a stalled server, got nil")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("request took %v to fail; the fallback should have ended it", elapsed)
	}
}

// A caller's own deadline replaces the fallback rather than racing it: a
// request allowed longer than the fallback (gh-student's sized blob read) is
// not cut off early.
func TestDeadlineTransport_CallerDeadlineOutlivesFallback(t *testing.T) {
	client := stalledClient(t, 20*time.Millisecond, RequestCeiling)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := client.RequestWithContext(ctx, http.MethodGet, "user", nil)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected the caller deadline to end the stalled request")
	}
	if elapsed < 250*time.Millisecond {
		t.Fatalf("request failed after %v; the 20ms fallback must not override a longer caller deadline", elapsed)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("request took %v; the caller deadline should have ended it", elapsed)
	}
}

// The ceiling still applies to a caller deadline longer than it.
func TestDeadlineTransport_CeilingCapsCallerDeadline(t *testing.T) {
	client := stalledClient(t, time.Hour, 50*time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
	defer cancel()
	start := time.Now()
	if _, err := client.RequestWithContext(ctx, http.MethodGet, "user", nil); err == nil {
		t.Fatal("expected the ceiling to end the stalled request")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("request took %v; the ceiling should have ended it", elapsed)
	}
}

// The success path through the production constructor: go-gh reads the body
// after RoundTrip returns, so a deadline cancelled on return (the obvious
// `defer cancel()` shape) would fail every command with "context canceled".
// A multi-KiB body makes sure the read outlives the transport call.
func TestNewRESTClient_DeliversBodyAfterRoundTrip(t *testing.T) {
	payload := map[string]string{"login": "octocat", "pad": strings.Repeat("x", 64<<10)}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(payload)
	}))
	t.Cleanup(server.Close)
	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	client, err := NewRESTClient(api.ClientOptions{
		Host:         "github.com",
		AuthToken:    "test-token",
		Transport:    &hostRewriteTransport{target: u},
		LogIgnoreEnv: true,
	})
	if err != nil {
		t.Fatalf("NewRESTClient: %v", err)
	}
	var got map[string]string
	if err := client.Get("user", &got); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got["login"] != payload["login"] || len(got["pad"]) != len(payload["pad"]) {
		t.Fatalf("body not delivered intact: login=%q pad=%d bytes", got["login"], len(got["pad"]))
	}
}

// recordingTransport hands back a canned response and keeps the request
// context so a test can watch when the deadline is released.
type recordingTransport struct{ ctx context.Context }

func (r *recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r.ctx = req.Context()
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader("body")),
		Request:    req,
	}, nil
}

// The deadline is released by Body.Close, not by RoundTrip returning.
func TestDeadlineTransport_CancelsOnBodyClose(t *testing.T) {
	inner := &recordingTransport{}
	dt := &deadlineTransport{next: inner, fallback: time.Hour, ceiling: RequestCeiling}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://example.invalid/", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	resp, err := dt.RoundTrip(req)
	if err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	if inner.ctx.Err() != nil {
		t.Fatalf("context ended before the body was read: %v", inner.ctx.Err())
	}
	if body, err := io.ReadAll(resp.Body); err != nil || string(body) != "body" {
		t.Fatalf("ReadAll = %q, %v", body, err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !errors.Is(inner.ctx.Err(), context.Canceled) {
		t.Fatalf("context after Close = %v, want canceled", inner.ctx.Err())
	}
}

// The deadline bounds the whole GET: a server that sends headers and then
// stalls mid-body fails the body read at the deadline rather than hanging.
func TestDeadlineTransport_DeadlineCoversBodyRead(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "partial")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)
	u, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	client, err := api.NewRESTClient(api.ClientOptions{
		Host:         "github.com",
		AuthToken:    "test-token",
		Transport:    &deadlineTransport{next: &hostRewriteTransport{target: u}, fallback: 50 * time.Millisecond, ceiling: RequestCeiling},
		LogIgnoreEnv: true,
	})
	if err != nil {
		t.Fatalf("NewRESTClient: %v", err)
	}
	start := time.Now()
	resp, err := client.Request(http.MethodGet, "user", nil)
	if err != nil {
		t.Fatalf("Request (headers): %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if _, err := io.ReadAll(resp.Body); err == nil {
		t.Fatal("expected the stalled body read to fail at the deadline, got nil")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("body read took %v to fail; the deadline should have ended it", elapsed)
	}
}

// A configured Unix socket is still honored: go-gh only dials it when no
// Transport is set, and NewRESTClient always sets one.
func TestNewRESTClient_DialsUnixDomainSocket(t *testing.T) {
	// macOS caps socket paths at 104 bytes; t.TempDir is too deep there.
	dir, err := os.MkdirTemp("", "gh")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socket := filepath.Join(dir, "s.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"login":"via-socket"}`)
	}))
	_ = server.Listener.Close()
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)

	client, err := NewRESTClient(api.ClientOptions{
		Host:             "github.com",
		AuthToken:        "test-token",
		UnixDomainSocket: socket,
		LogIgnoreEnv:     true,
	})
	if err != nil {
		t.Fatalf("NewRESTClient: %v", err)
	}
	var got struct{ Login string }
	if err := client.Get("user", &got); err != nil {
		t.Fatalf("Get over the socket: %v", err)
	}
	if got.Login != "via-socket" {
		t.Fatalf("login = %q, want the socket server's answer", got.Login)
	}
}
