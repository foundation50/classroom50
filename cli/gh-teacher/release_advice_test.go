package main

import (
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/updatecheck"
	"github.com/foundation50/gh-teacher/internal/assignment"
)

// TestReleaseAdviceWiring pins what main needs for the release follow-up: the
// #1055 parse error (an unrelated entry with an unknown mode) is marked stale,
// and the lookup targets this binary's extension repo.
func TestReleaseAdviceWiring(t *testing.T) {
	_, err := assignment.ParseAssignments([]byte(`{"schema":"classroom50/assignments/v1","assignments":[{"slug":"tp1","name":"TP1","mode":"individual","autograder":"default"},{"slug":"tp3","name":"TP3","mode":"squad","autograder":"default"}]}`))
	if !updatecheck.MaybeStale(err) {
		t.Errorf("parse error %v is not marked stale", err)
	}
	if opts := releaseOptions(); opts.Repo != contract.TeacherExtensionRepo || opts.Current != version {
		t.Errorf("releaseOptions() = %+v", opts)
	}
}
