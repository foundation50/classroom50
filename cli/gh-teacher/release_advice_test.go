package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/updatecheck"
	"github.com/foundation50/gh-teacher/internal/assignment"
)

// TestReleaseAdvice wires the #1055 shape (an unrelated entry with a mode this
// binary does not know) through to the line main prints after the error.
func TestReleaseAdvice(t *testing.T) {
	_, err := assignment.ParseAssignments([]byte(`{"schema":"classroom50/assignments/v1","assignments":[{"slug":"tp1","name":"TP1","mode":"individual","autograder":"default"},{"slug":"tp3","name":"TP3","mode":"squad","autograder":"default"}]}`))
	if err == nil {
		t.Fatal("expected a parse error")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"v1.55.0"}`))
	}))
	t.Cleanup(srv.Close)

	opts := releaseOptions()
	opts.Current, opts.APIBase = "v1.40.0", srv.URL
	got := updatecheck.Advice(context.Background(), err, opts, "Fix the value in assignments.json")
	for _, want := range []string{"gh-teacher: you have v1.40.0", "v1.55.0", "gh extension upgrade foundation50/gh-teacher"} {
		if !strings.Contains(got, want) {
			t.Errorf("advice %q lacks %q", got, want)
		}
	}

	opts.Current = "v1.55.0"
	got = updatecheck.Advice(context.Background(), err, opts, "Fix the value in assignments.json")
	if !strings.HasSuffix(got, "Fix the value in assignments.json") {
		t.Errorf("current advice = %q", got)
	}
}
