package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/updatecheck"
)

// TestReleaseAdvice wires an unsupported mode through to the line main prints
// after the accept error.
func TestReleaseAdvice(t *testing.T) {
	err := checkAcceptableMode("hello", "squad")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"v1.55.0"}`))
	}))
	t.Cleanup(srv.Close)

	opts := releaseOptions()
	opts.Current, opts.APIBase = "v1.40.0", srv.URL
	got := updatecheck.Advice(context.Background(), err, opts, "Ask your teacher")
	for _, want := range []string{"gh-student: you have v1.40.0", "v1.55.0", "gh extension upgrade foundation50/gh-student"} {
		if !strings.Contains(got, want) {
			t.Errorf("advice %q lacks %q", got, want)
		}
	}

	opts.Current = "v1.55.0"
	got = updatecheck.Advice(context.Background(), err, opts, "Ask your teacher")
	if !strings.HasSuffix(got, "Ask your teacher") {
		t.Errorf("current advice = %q", got)
	}
}
