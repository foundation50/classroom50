package assignmentcmd

import (
	"bytes"
	"reflect"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/githubtest"
)

// The pages carry-forward on a same-slug re-add (issue #919): omitted --pages
// keeps a stored (often GUI-authored) block; an explicit --pages off resets it;
// --empty-repo drops it with a warning instead of failing on a flag the
// teacher never passed.
func TestRunAssignmentAdd_PagesCarryForward(t *testing.T) {
	const assignments = `{
  "schema": "classroom50/assignments/v1",
  "assignments": [
    {
      "slug": "hello",
      "name": "Hello",
      "template": { "owner": "o", "repo": "hello-template", "branch": "main" },
      "mode": "individual",
      "autograder": "default",
      "pages": { "source": "branch", "path": "/docs" },
      "feedback_pr": true
    }
  ]
}`
	base := func() addAssignmentParams {
		return addAssignmentParams{
			Org:        "o",
			Classroom:  "dst",
			Slug:       "hello",
			Name:       "Hello",
			Tmpl:       &templateArg{Owner: "o", Repo: "hello-template"},
			Mode:       assignment.ModeIndividual,
			Autograder: "default",
		}
	}
	stored := &assignment.PagesConfig{Source: "branch", Path: "/docs"}

	t.Run("omitted --pages keeps the stored block", func(t *testing.T) {
		server, fix := newLockServer(t, lockServerConfig{assignments: assignments, classroom: lockClassroomBody()})
		var out, errOut bytes.Buffer
		if err := runAssignmentAdd(githubtest.NewTestClient(t, server), &out, &errOut, base()); err != nil {
			t.Fatalf("runAssignmentAdd: %v", err)
		}
		got := decodeLock(t, fix).Assignments[0].Pages
		if !reflect.DeepEqual(got, stored) {
			t.Errorf("pages = %+v, want %+v carried forward", got, stored)
		}
	})

	t.Run("explicit --pages off resets it", func(t *testing.T) {
		server, fix := newLockServer(t, lockServerConfig{assignments: assignments, classroom: lockClassroomBody()})
		p := base()
		p.PagesChanged = true // --pages off normalizes to a nil block
		var out, errOut bytes.Buffer
		if err := runAssignmentAdd(githubtest.NewTestClient(t, server), &out, &errOut, p); err != nil {
			t.Fatalf("runAssignmentAdd: %v", err)
		}
		if got := decodeLock(t, fix).Assignments[0].Pages; got != nil {
			t.Errorf("explicit --pages off must clear the block, got %+v", got)
		}
	})

	t.Run("--empty-repo drops the stored block with a warning", func(t *testing.T) {
		server, fix := newLockServer(t, lockServerConfig{assignments: assignments, classroom: lockClassroomBody()})
		p := base()
		p.Tmpl = nil
		p.EmptyRepo = true
		p.FeedbackPR = false
		var out, errOut bytes.Buffer
		if err := runAssignmentAdd(githubtest.NewTestClient(t, server), &out, &errOut, p); err != nil {
			t.Fatalf("--empty-repo re-add must not fail on a carried pages block: %v", err)
		}
		if got := decodeLock(t, fix).Assignments[0].Pages; got != nil {
			t.Errorf("--empty-repo must drop the pages block, got %+v", got)
		}
		if !strings.Contains(errOut.String(), "dropped its GitHub Pages setting") {
			t.Errorf("expected a dropped-Pages warning:\n%s", errOut.String())
		}
	})
}
