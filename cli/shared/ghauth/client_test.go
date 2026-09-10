package ghauth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/api"
)

func TestWithRequestTimeout(t *testing.T) {
	if got := withRequestTimeout(api.ClientOptions{}).Timeout; got != RequestTimeout {
		t.Fatalf("default Timeout = %v, want %v", got, RequestTimeout)
	}
	if got := withRequestTimeout(api.ClientOptions{Timeout: time.Second}).Timeout; got != time.Second {
		t.Fatalf("explicit Timeout = %v, want 1s to be preserved", got)
	}
}

// A server that accepts but never answers must fail the request at the
// configured timeout rather than hanging.
func TestNewRESTClient_TimeoutEndsStalledRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
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
		Timeout:      50 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewRESTClient: %v", err)
	}

	start := time.Now()
	err = client.Get("user", nil)
	if err == nil {
		t.Fatal("expected a timeout error against a stalled server, got nil")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("request took %v to fail; the timeout should have ended it", elapsed)
	}
}
