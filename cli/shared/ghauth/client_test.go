package ghauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/api"
)

func TestWithRequestTimeout(t *testing.T) {
	got := withRequestTimeout(api.ClientOptions{})
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
