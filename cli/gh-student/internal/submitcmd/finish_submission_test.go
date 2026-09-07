package submitcmd

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/ui"
)

// _finishHarness drives finishSubmission with a shared out/err buffer so the
// CONFIRM marker (announce) and any warning are ordering-assertable by index,
// plus a counting retry stub.
type _finishHarness struct {
	buf        bytes.Buffer
	u          *ui.UI
	retryCalls int
}

func _newFinishHarness() *_finishHarness {
	h := &_finishHarness{}
	h.u = ui.NewForced(&h.buf, false)
	return h
}

func (h *_finishHarness) announce() func() {
	return func() { h.buf.WriteString("CONFIRM\n") }
}

func (h *_finishHarness) retry(entry *assignments.Entry, err error) func(context.Context) (*assignments.Entry, error) {
	return func(context.Context) (*assignments.Entry, error) {
		h.retryCalls++
		return entry, err
	}
}

func _tagModeEntry() *assignments.Entry {
	return &assignments.Entry{SubmissionMode: contract.SubmissionModeTag}
}

// _deadRemote repoints the fixture's origin at a nonexistent path so any tag
// push fails (mirrors TestPushSubmitTag_PushFailureSurfacesError).
func _deadRemote(t *testing.T, local string) {
	t.Helper()
	if out, err := exec.Command(
		"git", "--git-dir", local, "remote", "set-url", "origin",
		filepath.Join(t.TempDir(), "gone.git"),
	).CombinedOutput(); err != nil {
		t.Fatalf("set-url: %v\n%s", err, out)
	}
}

func TestFinishSubmission_TagModePushesTag(t *testing.T) {
	local, remote, sha := _tagTestRepos(t)
	h := _newFinishHarness()

	err := finishSubmission(context.Background(), _tagModeEntry(), nil,
		h.retry(nil, errors.New("retry must not run")),
		local, sha, "https://x", false, h.u, h.announce())
	if err != nil {
		t.Fatalf("finishSubmission: %v", err)
	}
	if h.retryCalls != 0 {
		t.Errorf("retryCalls = %d, want 0 (entry already resolved)", h.retryCalls)
	}
	if tags := _remoteTags(t, remote); len(tags) != 1 || !strings.HasPrefix(tags[0], "submit/") {
		t.Errorf("remote tags = %v, want exactly one submit/* tag", tags)
	}
	out := h.buf.String()
	if !strings.Contains(out, "CONFIRM") {
		t.Errorf("confirmation not printed:\n%s", out)
	}
	if strings.Contains(out, "could not determine") {
		t.Errorf("unexpected mode-unknown warning:\n%s", out)
	}
}

func TestFinishSubmission_EveryPushNeverTags(t *testing.T) {
	// Both the absent wire default and an explicit every-push: no tag, no
	// retry, no warning — the branch push already grades.
	for _, mode := range []string{"", contract.SubmissionModeEveryPush} {
		t.Run("mode="+mode, func(t *testing.T) {
			local, remote, sha := _tagTestRepos(t)
			h := _newFinishHarness()

			entry := &assignments.Entry{SubmissionMode: mode}
			err := finishSubmission(context.Background(), entry, nil,
				h.retry(nil, errors.New("retry must not run")),
				local, sha, "https://x", false, h.u, h.announce())
			if err != nil {
				t.Fatalf("finishSubmission: %v", err)
			}
			if h.retryCalls != 0 {
				t.Errorf("retryCalls = %d, want 0", h.retryCalls)
			}
			if tags := _remoteTags(t, remote); len(tags) != 0 {
				t.Errorf("remote tags = %v, want none", tags)
			}
			if out := h.buf.String(); !strings.Contains(out, "CONFIRM") || strings.Contains(out, "could not determine") {
				t.Errorf("want confirmation and no warning, got:\n%s", out)
			}
		})
	}
}

func TestFinishSubmission_NilEntryNilErrNoOps(t *testing.T) {
	// Defensive shape (fetchSubmitEntry never returns it): no retry, no tag,
	// no warning.
	h := _newFinishHarness()
	err := finishSubmission(context.Background(), nil, nil,
		h.retry(nil, errors.New("retry must not run")),
		"/nonexistent-git-dir", "deadbeef", "https://x", false, h.u, h.announce())
	if err != nil {
		t.Fatalf("finishSubmission: %v", err)
	}
	if h.retryCalls != 0 {
		t.Errorf("retryCalls = %d, want 0", h.retryCalls)
	}
	if out := h.buf.String(); !strings.Contains(out, "CONFIRM") || strings.Contains(out, "could not determine") {
		t.Errorf("want confirmation only, got:\n%s", out)
	}
}

func TestFinishSubmission_RetryResolvesTagMode(t *testing.T) {
	// The headline regression: pre-push fetch failed, the post-push retry
	// resolves tag mode — the tag is pushed, grading proceeds, NO warning.
	local, remote, sha := _tagTestRepos(t)
	h := _newFinishHarness()

	err := finishSubmission(context.Background(), nil, errors.New("pages blip"),
		h.retry(_tagModeEntry(), nil),
		local, sha, "https://x", false, h.u, h.announce())
	if err != nil {
		t.Fatalf("finishSubmission: %v", err)
	}
	if h.retryCalls != 1 {
		t.Errorf("retryCalls = %d, want exactly 1", h.retryCalls)
	}
	if tags := _remoteTags(t, remote); len(tags) != 1 || !strings.HasPrefix(tags[0], "submit/") {
		t.Errorf("remote tags = %v, want the submit/* tag from the retried entry", tags)
	}
	if out := h.buf.String(); strings.Contains(out, "could not determine") {
		t.Errorf("retry succeeded — no warning expected:\n%s", out)
	}
}

func TestFinishSubmission_RetryResolvesEveryPush(t *testing.T) {
	local, remote, sha := _tagTestRepos(t)
	h := _newFinishHarness()

	err := finishSubmission(context.Background(), nil, errors.New("pages blip"),
		h.retry(&assignments.Entry{}, nil),
		local, sha, "https://x", false, h.u, h.announce())
	if err != nil {
		t.Fatalf("finishSubmission: %v", err)
	}
	if h.retryCalls != 1 {
		t.Errorf("retryCalls = %d, want 1", h.retryCalls)
	}
	if tags := _remoteTags(t, remote); len(tags) != 0 {
		t.Errorf("remote tags = %v, want none (every-push)", tags)
	}
	if out := h.buf.String(); strings.Contains(out, "could not determine") {
		t.Errorf("mode resolved — no warning expected:\n%s", out)
	}
}

func TestFinishSubmission_RetryFailsWarnsAfterConfirmation(t *testing.T) {
	// Both fetches failed: no tag (never tag blind), and the warning prints
	// strictly AFTER the confirmation — the deliberate ordering so it's the
	// last thing a tag-mode student sees.
	h := _newFinishHarness()
	retryErr := errors.New("pages still down")

	err := finishSubmission(context.Background(), nil, errors.New("pages blip"),
		h.retry(nil, retryErr),
		"/nonexistent-git-dir", "deadbeef", "https://x", false, h.u, h.announce())
	if err != nil {
		t.Fatalf("finishSubmission: %v", err)
	}
	if h.retryCalls != 1 {
		t.Errorf("retryCalls = %d, want exactly 1 (no retry loop)", h.retryCalls)
	}
	out := h.buf.String()
	ci := strings.Index(out, "CONFIRM")
	wi := strings.Index(out, "could not determine")
	if ci == -1 || wi == -1 {
		t.Fatalf("want both confirmation and warning, got:\n%s", out)
	}
	if wi < ci {
		t.Errorf("warning printed before the confirmation:\n%s", out)
	}
	if !strings.Contains(out, retryErr.Error()) {
		t.Errorf("warning should carry the RETRY's error, got:\n%s", out)
	}
}

func TestFinishSubmission_TagPushFailureIsFatal(t *testing.T) {
	// A tag-mode tag-push failure returns the wrapped re-run guidance and
	// never prints the confirmation (the submission is not "done").
	local, _, sha := _tagTestRepos(t)
	_deadRemote(t, local)
	h := _newFinishHarness()

	err := finishSubmission(context.Background(), _tagModeEntry(), nil,
		h.retry(nil, errors.New("retry must not run")),
		local, sha, "https://x", false, h.u, h.announce())
	if err == nil {
		t.Fatal("want the wrapped tag-push error")
	}
	if !strings.Contains(err.Error(), "run `gh student submit` again") {
		t.Errorf("error missing the re-run guidance: %v", err)
	}
	if out := h.buf.String(); strings.Contains(out, "CONFIRM") {
		t.Errorf("confirmation must not print on a fatal tag-push failure:\n%s", out)
	}
}

func TestFinishSubmission_RetryThenTagPushFailure(t *testing.T) {
	// The retry path feeds the same fatal contract: retry resolves tag mode,
	// the push fails, the wrapped error surfaces, no confirmation.
	local, _, sha := _tagTestRepos(t)
	_deadRemote(t, local)
	h := _newFinishHarness()

	err := finishSubmission(context.Background(), nil, errors.New("pages blip"),
		h.retry(_tagModeEntry(), nil),
		local, sha, "https://x", false, h.u, h.announce())
	if err == nil {
		t.Fatal("want the wrapped tag-push error")
	}
	if h.retryCalls != 1 {
		t.Errorf("retryCalls = %d, want 1", h.retryCalls)
	}
	if !strings.Contains(err.Error(), "run `gh student submit` again") {
		t.Errorf("error missing the re-run guidance: %v", err)
	}
	if out := h.buf.String(); strings.Contains(out, "CONFIRM") {
		t.Errorf("confirmation must not print on a fatal tag-push failure:\n%s", out)
	}
}
