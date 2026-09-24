package submitcmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/classroomcfg"
	"github.com/foundation50/gh-student/internal/githubapi"
	"github.com/foundation50/gh-student/internal/ui"
)

// stubPages installs fake classrooms-index and per-classroom manifest readers
// for one test. manifests maps classroom -> entries; a classroom absent from
// it answers a whole-manifest 404 (unlisted or unpublished).
func stubPages(t *testing.T, index []assignments.ClassroomSummary, manifests map[string][]assignments.Entry) *[]string {
	t.Helper()
	origIndex, origManifest := fetchClassroomsIndexFn, fetchManifestFn
	t.Cleanup(func() { fetchClassroomsIndexFn, fetchManifestFn = origIndex, origManifest })

	var fetched []string
	fetchClassroomsIndexFn = func(context.Context, string) ([]assignments.ClassroomSummary, error) {
		return index, nil
	}
	fetchManifestFn = func(_ context.Context, _, classroom, secret string) ([]assignments.Entry, error) {
		fetched = append(fetched, classroom+"?key="+secret)
		entries, ok := manifests[classroom]
		if !ok {
			return nil, fmt.Errorf("%s/assignments.json returned 404: %w", classroom, assignments.ErrManifestNotFound)
		}
		return entries, nil
	}
	return &fetched
}

func testUI() *ui.UI { return ui.New(io.Discard) }

func tpl(owner, repo, branch string) *assignments.TemplateRef {
	return &assignments.TemplateRef{Owner: owner, Repo: repo, Branch: branch}
}

func TestResolveFromRepoName_NoAutograderRepo(t *testing.T) {
	// The #1049 shape: a templated no_autograder accept wrote no marker. The
	// resolver must find the classroom and slug from the name and must NOT
	// point submit at the template for a .gitignore/.github refresh, since
	// these repos are promised to stay free of Classroom 50 writes.
	stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "cs50"}, {ShortName: "other"}},
		map[string][]assignments.Entry{
			"cs50": {
				{Slug: "hello", NoAutograder: true, Template: tpl("cs50", "hello-tpl", "main")},
				{Slug: "mario", Template: tpl("cs50", "mario-tpl", "main")},
			},
		})

	cfg, entry, err := resolveFromRepoName(context.Background(), "org", "cs50-hello-alice", "", testUI(), false)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Classroom != "cs50" || cfg.Assignment != "hello" {
		t.Errorf("config = %s/%s, want cs50/hello", cfg.Classroom, cfg.Assignment)
	}
	if cfg.Source != nil {
		t.Errorf("a no_autograder repo must not get a teacher-file source, got %+v", cfg.Source)
	}
	if entry == nil || entry.Slug != "hello" || !entry.NoAutograder {
		t.Errorf("entry = %+v, want the matched no_autograder row", entry)
	}
}

func TestResolveFromRepoName_MarkerlessBuiltInKeepsTemplateSource(t *testing.T) {
	// A built-in-autograder repo whose student deleted the marker (or one
	// accepted as no_autograder before the teacher turned the autograder on)
	// resolves like any other repo and keeps the template refresh.
	stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "cs50"}},
		map[string][]assignments.Entry{
			"cs50": {{Slug: "mario", Template: tpl("cs50", "mario-tpl", "dev")}},
		})

	cfg, _, err := resolveFromRepoName(context.Background(), "org", "cs50-mario-bob", "", testUI(), false)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	want := &classroomcfg.Source{Owner: "cs50", Repo: "mario-tpl", Branch: "dev"}
	if cfg.Source == nil || *cfg.Source != *want {
		t.Errorf("source = %+v, want %+v", cfg.Source, want)
	}
}

func TestResolveFromRepoName_GroupRepoAndCase(t *testing.T) {
	// Group repos end in group-N, and GitHub may show the owner segment in
	// any case; matching is on the lowercased prefix only. An empty_repo
	// entry keeps no teacher-file source even when it carries a template.
	stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "CS50"}},
		map[string][]assignments.Entry{
			"CS50": {{Slug: "final", Mode: "team", EmptyRepo: true, Template: tpl("cs50", "final-tpl", "main")}},
		})

	cfg, _, err := resolveFromRepoName(context.Background(), "org", "cs50-final-group-3", "", testUI(), false)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Classroom != "CS50" || cfg.Assignment != "final" {
		t.Errorf("config = %s/%s, want CS50/final", cfg.Classroom, cfg.Assignment)
	}
	if cfg.Source != nil {
		t.Errorf("an empty_repo repo must not get a teacher-file source, got %+v", cfg.Source)
	}
}

func TestResolveFromRepoName_LongestSlugWins(t *testing.T) {
	// "hw" also prefixes every "hw-extra" repo (the sibling-slug over-match
	// the rename command documents); the longer prefix is the real owner.
	stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "cs50"}},
		map[string][]assignments.Entry{
			"cs50": {{Slug: "hw"}, {Slug: "hw-extra"}},
		})

	cfg, _, err := resolveFromRepoName(context.Background(), "org", "cs50-hw-extra-alice", "", testUI(), false)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Assignment != "hw-extra" {
		t.Errorf("assignment = %q, want hw-extra", cfg.Assignment)
	}
}

func TestResolveFromRepoName_RenamedFromMatches(t *testing.T) {
	// A repo a partially completed rename left behind still carries the old
	// slug; renamed_from lets it resolve to the current entry.
	stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "cs50"}},
		map[string][]assignments.Entry{
			"cs50": {{Slug: "pset1", RenamedFrom: "hello"}},
		})

	cfg, _, err := resolveFromRepoName(context.Background(), "org", "cs50-hello-alice", "", testUI(), false)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Assignment != "pset1" {
		t.Errorf("assignment = %q, want the current slug pset1", cfg.Assignment)
	}
}

func TestResolveFromRepoName_ClassroomPrefixNarrowsFetches(t *testing.T) {
	// Only classrooms whose short name prefixes the repo name are fetched;
	// an unrelated classroom costs no request.
	fetched := stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "cs50"}, {ShortName: "cs50-summer"}, {ShortName: "art"}},
		map[string][]assignments.Entry{
			"cs50":        {{Slug: "hello"}},
			"cs50-summer": {{Slug: "intro"}},
		})

	if _, _, err := resolveFromRepoName(context.Background(), "org", "cs50-summer-intro-alice", "", testUI(), false); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	got := strings.Join(*fetched, " ")
	if strings.Contains(got, "art") {
		t.Errorf("unrelated classroom fetched: %s", got)
	}
	if !strings.Contains(got, "cs50?") || !strings.Contains(got, "cs50-summer?") {
		t.Errorf("both prefix candidates should be fetched, got %s", got)
	}
}

func TestResolveFromRepoName_AmbiguousAcrossClassrooms(t *testing.T) {
	// "a" + "b-c" and "a-b" + "c" both compose to a-b-c-; the name alone can't
	// settle it, so the student is told to ask rather than guessing.
	stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "a"}, {ShortName: "a-b"}},
		map[string][]assignments.Entry{
			"a":   {{Slug: "b-c"}},
			"a-b": {{Slug: "c"}},
		})

	_, _, err := resolveFromRepoName(context.Background(), "org", "a-b-c-alice", "", testUI(), false)
	if err == nil || !strings.Contains(err.Error(), "more than one published assignment") {
		t.Fatalf("err = %v, want an ambiguity error", err)
	}
	for _, want := range []string{"a/b-c", "a-b/c"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("ambiguity error should name %s, got %q", want, err)
		}
	}
}

func TestResolveFromRepoName_UnlistedClassroomNeedsKey(t *testing.T) {
	// A protected classroom is in the index but its manifest 404s without
	// the key. Never push blind: a tag-mode assignment would not grade.
	stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "secret-class"}},
		map[string][]assignments.Entry{})

	_, _, err := resolveFromRepoName(context.Background(), "org", "secret-class-hello-alice", "", testUI(), false)
	if err == nil || !strings.Contains(err.Error(), "--key <key>") {
		t.Fatalf("err = %v, want a --key hint", err)
	}
	if !strings.Contains(err.Error(), `"secret-class"`) {
		t.Errorf("error should name the classroom, got %q", err)
	}
}

func TestResolveFromRepoName_KeyReachesManifestAndConfig(t *testing.T) {
	// With --key the protected manifest is fetched under the key, and the
	// synthesized config carries it so later Pages reads use the same path.
	fetched := stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "secret-class"}},
		map[string][]assignments.Entry{
			"secret-class": {{Slug: "hello", NoAutograder: true}},
		})

	cfg, _, err := resolveFromRepoName(context.Background(), "org", "secret-class-hello-alice", "k3y1", testUI(), false)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Secret != "k3y1" {
		t.Errorf("secret = %q, want the key", cfg.Secret)
	}
	if got := strings.Join(*fetched, " "); !strings.Contains(got, "secret-class?key=k3y1") {
		t.Errorf("manifest should be fetched with the key, got %s", got)
	}
}

func TestResolveFromRepoName_WrongKeyIsNamedPlainly(t *testing.T) {
	// A manifest 404 under a supplied key is a wrong key (or a key passed for
	// a plain classroom), not a publishing problem; say so in one line instead
	// of stacking the fetch layer's Pages guidance.
	stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "secret-class"}},
		map[string][]assignments.Entry{})

	_, _, err := resolveFromRepoName(context.Background(), "org", "secret-class-hello-alice", "wr0ng", testUI(), false)
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{`"secret-class"`, "double-check the key", "omit --key"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should contain %q, got %q", want, err)
		}
	}
	for _, reject := range []string{"publish-pages", "404"} {
		if strings.Contains(err.Error(), reject) {
			t.Errorf("error should not carry the fetch layer's %q text, got %q", reject, err)
		}
	}
}

func TestResolveFromRepoName_UnlistedDoesNotMaskPlainMatch(t *testing.T) {
	// One candidate is unlisted and one is plain and matches: the match wins
	// and no --key hint is raised.
	stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "cs"}, {ShortName: "cs-private"}},
		map[string][]assignments.Entry{
			"cs": {{Slug: "private-hello"}},
		})

	cfg, _, err := resolveFromRepoName(context.Background(), "org", "cs-private-hello-alice", "", testUI(), false)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.Classroom != "cs" || cfg.Assignment != "private-hello" {
		t.Errorf("config = %s/%s, want cs/private-hello", cfg.Classroom, cfg.Assignment)
	}
}

func TestResolveFromRepoName_NoClassroomPrefix(t *testing.T) {
	stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "cs50"}},
		map[string][]assignments.Entry{"cs50": {{Slug: "hello"}}})

	_, _, err := resolveFromRepoName(context.Background(), "org", "my-own-repo", "", testUI(), false)
	if err == nil || !strings.Contains(err.Error(), "git push` directly") {
		t.Fatalf("err = %v, want the push-directly fallback", err)
	}
}

func TestResolveFromRepoName_NoSlugMatch(t *testing.T) {
	stubPages(t,
		[]assignments.ClassroomSummary{{ShortName: "cs50"}},
		map[string][]assignments.Entry{"cs50": {{Slug: "hello"}}})

	_, _, err := resolveFromRepoName(context.Background(), "org", "cs50-unknown-alice", "", testUI(), false)
	if err == nil || !strings.Contains(err.Error(), `published for classroom "cs50"`) {
		t.Fatalf("err = %v, want a no-match error naming the classroom", err)
	}
}

func TestResolveFromRepoName_LookupErrorPropagates(t *testing.T) {
	// A transport failure on the manifest is neither "unlisted" nor "no
	// match"; it surfaces as-is so the student sees the real cause.
	stubPages(t, []assignments.ClassroomSummary{{ShortName: "cs50"}}, nil)
	fetchManifestFn = func(context.Context, string, string, string) ([]assignments.Entry, error) {
		return nil, errors.New("dial tcp: connection refused")
	}

	_, _, err := resolveFromRepoName(context.Background(), "org", "cs50-hello-alice", "", testUI(), false)
	if err == nil || !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("err = %v, want the transport error", err)
	}
}

func TestResolveFromRepoName_IndexErrorPropagates(t *testing.T) {
	orig := fetchClassroomsIndexFn
	t.Cleanup(func() { fetchClassroomsIndexFn = orig })
	fetchClassroomsIndexFn = func(context.Context, string) ([]assignments.ClassroomSummary, error) {
		return nil, errors.New("returned 404: the organization has no published Classroom 50 site")
	}

	_, _, err := resolveFromRepoName(context.Background(), "org", "cs50-hello-alice", "", testUI(), false)
	if err == nil || !strings.Contains(err.Error(), "no published Classroom 50 site") {
		t.Fatalf("err = %v, want the index error", err)
	}
}

func TestReadOrResolveConfig(t *testing.T) {
	writeMarker := func(t *testing.T, dir, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, classroomcfg.MetadataPath), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("marker present: read as before, resolver never runs", func(t *testing.T) {
		dir := t.TempDir()
		writeMarker(t, dir, "classroom: cs50\nassignment: hello\n")
		orig := fetchClassroomsIndexFn
		t.Cleanup(func() { fetchClassroomsIndexFn = orig })
		fetchClassroomsIndexFn = func(context.Context, string) ([]assignments.ClassroomSummary, error) {
			t.Fatal("resolver must not run when the marker exists")
			return nil, nil
		}

		cfg, entry, err := readOrResolveConfig(context.Background(), dir, "org", "cs50-hello-alice", "", testUI(), false)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if cfg.Assignment != "hello" || entry != nil {
			t.Errorf("cfg=%+v entry=%v, want the marker's values and no pre-fetched entry", cfg, entry)
		}
	})

	t.Run("marker present without secret: --key fills it in", func(t *testing.T) {
		dir := t.TempDir()
		writeMarker(t, dir, "classroom: cs50\nassignment: hello\n")
		cfg, _, err := readOrResolveConfig(context.Background(), dir, "org", "cs50-hello-alice", "abcd", testUI(), false)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if cfg.Secret != "abcd" {
			t.Errorf("secret = %q, want abcd", cfg.Secret)
		}
	})

	t.Run("marker present with a different secret: --key is rejected", func(t *testing.T) {
		dir := t.TempDir()
		writeMarker(t, dir, "classroom: cs50\nassignment: hello\nsecret: abcd\n")
		_, _, err := readOrResolveConfig(context.Background(), dir, "org", "cs50-hello-alice", "wxyz", testUI(), false)
		if err == nil || !strings.Contains(err.Error(), "does not match") {
			t.Fatalf("err = %v, want a mismatch error", err)
		}
	})

	t.Run("marker present with the same secret: --key is accepted", func(t *testing.T) {
		dir := t.TempDir()
		writeMarker(t, dir, "classroom: cs50\nassignment: hello\nsecret: abcd\n")
		cfg, _, err := readOrResolveConfig(context.Background(), dir, "org", "cs50-hello-alice", "abcd", testUI(), false)
		if err != nil {
			t.Fatalf("a key equal to the recorded secret must be accepted, got %v", err)
		}
		if cfg.Secret != "abcd" {
			t.Errorf("secret = %q, want abcd", cfg.Secret)
		}
	})

	t.Run("marker absent: resolver runs and its entry is returned", func(t *testing.T) {
		dir := t.TempDir()
		stubPages(t,
			[]assignments.ClassroomSummary{{ShortName: "cs50"}},
			map[string][]assignments.Entry{"cs50": {{Slug: "hello", NoAutograder: true}}})

		cfg, entry, err := readOrResolveConfig(context.Background(), dir, "org", "cs50-hello-alice", "", testUI(), false)
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if cfg.Assignment != "hello" || entry == nil {
			t.Errorf("cfg=%+v entry=%v, want the resolved values and the pre-fetched entry", cfg, entry)
		}
	})

	t.Run("marker unreadable for another reason: error passes through", func(t *testing.T) {
		dir := t.TempDir()
		writeMarker(t, dir, "classroom: cs50\n") // missing assignment
		_, _, err := readOrResolveConfig(context.Background(), dir, "org", "cs50-hello-alice", "", testUI(), false)
		if err == nil || !strings.Contains(err.Error(), "missing assignment") {
			t.Fatalf("err = %v, want the ReadConfig validation error", err)
		}
		if errors.Is(err, fs.ErrNotExist) {
			t.Errorf("a malformed marker must not read as absent")
		}
	})
}

// Guard against a silent break of the fallback: the resolver is only reached
// through fs.ErrNotExist, which ReadConfig wraps with %w.
func TestReadConfigMissingFileIsErrNotExist(t *testing.T) {
	_, err := classroomcfg.ReadConfig(filepath.Join(t.TempDir(), classroomcfg.MetadataPath))
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("err = %v, want fs.ErrNotExist so submit can fall back to the repo name", err)
	}
}

func TestRefuseStaleMarkerlessClone(t *testing.T) {
	stub := func(t *testing.T, exists bool, err error) *[]string {
		t.Helper()
		orig := remoteFileExistsFn
		t.Cleanup(func() { remoteFileExistsFn = orig })
		var probed []string
		remoteFileExistsFn = func(_ githubapi.Client, owner, repo, path string) (bool, error) {
			probed = append(probed, owner+"/"+repo+":"+path)
			return exists, err
		}
		return &probed
	}

	t.Run("remote has the marker the clone lacks: stop and say git pull", func(t *testing.T) {
		// The enable-autograder backfill committed .classroom50.yaml and the
		// shim to the remote; a snapshot push from this stale clone would
		// delete both and report success.
		probed := stub(t, true, nil)
		err := refuseStaleMarkerlessClone(nil, "org", "cs50-hello-alice")
		if err == nil || !strings.Contains(err.Error(), "git pull") {
			t.Fatalf("err = %v, want a git pull instruction", err)
		}
		if got := strings.Join(*probed, " "); got != "org/cs50-hello-alice:"+classroomcfg.MetadataPath {
			t.Errorf("probed %q, want the marker path on the clone's remote", got)
		}
	})

	t.Run("remote has no marker either: proceed", func(t *testing.T) {
		stub(t, false, nil)
		if err := refuseStaleMarkerlessClone(nil, "org", "cs50-hello-alice"); err != nil {
			t.Fatalf("a genuinely markerless repo must submit, got %v", err)
		}
	})

	t.Run("probe fails: stop rather than guess", func(t *testing.T) {
		stub(t, false, errors.New("GET repos/...: 502"))
		err := refuseStaleMarkerlessClone(nil, "org", "cs50-hello-alice")
		if err == nil || !strings.Contains(err.Error(), "502") {
			t.Fatalf("err = %v, want the probe error surfaced", err)
		}
	})
}
