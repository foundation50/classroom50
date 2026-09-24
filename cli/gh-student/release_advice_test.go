package main

import (
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/classroom50-cli-shared/updatecheck"
)

// TestReleaseAdviceWiring pins what main needs for the release follow-up: an
// unsupported mode is marked stale, and the lookup targets this binary's
// extension repo.
func TestReleaseAdviceWiring(t *testing.T) {
	if err := checkAcceptableMode("hello", "squad"); !updatecheck.MaybeStale(err) {
		t.Errorf("unsupported mode error %v is not marked stale", err)
	}
	if opts := releaseOptions(); opts.Repo != contract.StudentExtensionRepo || opts.Current != version {
		t.Errorf("releaseOptions() = %+v", opts)
	}
}
