package contract

// BaselineSource says which commit anchors a student repo's baseline: the
// Feedback PR base and the first commit that counts as a submission. Every
// reader of a repo's history resolves it through this one rule so they agree;
// the web (repoRefReads.ts baselineSource), collect_scores.py, regrade_repos.py
// and runner.py hand-mirror it, pinned together by
// cli/shared/testdata/baseline_source_cases.json.
type BaselineSource string

const (
	// BaselineMarker: the oldest commit touching .classroom50.yaml is the
	// accept commit.
	BaselineMarker BaselineSource = "marker"
	// BaselineRoot: the branch's root commit. Either no marker exists and the
	// repo's shape says the root is the seed, or the marker was introduced by
	// the enable-autograder backfill on a repo accepted without one.
	BaselineRoot BaselineSource = "root"
	// BaselineNone: no baseline (a bare empty_repo, or a built-in-autograder
	// repo whose accept never landed the marker).
	BaselineNone BaselineSource = "none"
)

// IsShimBackfillCommit reports whether a commit message is the
// enable-autograder backfill's: subject compared exactly after trimming, body
// ignored. A marker that commit introduced must not anchor the baseline.
func IsShimBackfillCommit(message string) bool {
	return CommitSubject(message) == ShimBackfillCommitSubject()
}

// ResolveBaselineSource applies the rule. markerMessage is the full message of
// the oldest commit touching the marker; hasMarker is false when none does.
// rootIsBaseline is true for every initialized repo (its root is the template
// or README seed), false only for a bare empty_repo or a built-in assignment
// whose accept is unfinished.
func ResolveBaselineSource(markerMessage string, hasMarker, rootIsBaseline bool) BaselineSource {
	if hasMarker && !IsShimBackfillCommit(markerMessage) {
		return BaselineMarker
	}
	if hasMarker || rootIsBaseline {
		return BaselineRoot
	}
	return BaselineNone
}
