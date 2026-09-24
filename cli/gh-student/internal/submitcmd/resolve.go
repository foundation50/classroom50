package submitcmd

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/foundation50/gh-student/internal/assignments"
	"github.com/foundation50/gh-student/internal/classroomcfg"
	"github.com/foundation50/gh-student/internal/githubapi"
	"github.com/foundation50/gh-student/internal/reponame"
	"github.com/foundation50/gh-student/internal/ui"
)

// Injectable Pages and GitHub readers so tests can drive the resolver without
// a live site.
var (
	fetchClassroomsIndexFn = assignments.FetchClassroomsIndex
	fetchManifestFn        = assignments.FetchManifest
	remoteFileExistsFn     = classroomcfg.FileExists
)

// markerlessErr prefixes every resolver failure with the one fact the student
// needs first: the clone has no marker. wiki/Troubleshooting.md keys its
// heading on this lead-in.
func markerlessErr(format string, args ...any) error {
	return fmt.Errorf(classroomcfg.MetadataPath+" not found in this clone, and "+format, args...)
}

// repoNameMatch is one (classroom, assignment) pair whose repo-name prefix the
// clone's repo name carries.
type repoNameMatch struct {
	classroom string
	entry     assignments.Entry
	// prefix is the matched `<classroom>-<slug>-`; the longest one wins so a
	// sibling slug that extends another ("hw" vs "hw-extra") can't claim the
	// longer assignment's repos.
	prefix string
}

// resolveFromRepoName recovers the marker a no_autograder or empty_repo accept
// never wrote, from the repo name and the org's published site, using the same
// repo-name prefix rule `gh teacher assignment rename` applies to markerless
// repos. A protected classroom's manifest lives under its key, so without
// --key the error says so rather than pushing blind (a tag-mode assignment
// would then never grade). The Entry is the matched manifest row so the caller
// need not fetch it again.
func resolveFromRepoName(ctx context.Context, org, repo, key string, u *ui.UI, verbose bool) (*classroomcfg.Config, *assignments.Entry, error) {
	if verbose {
		u.Detail("No %s in this clone; resolving the assignment from the repository name", classroomcfg.MetadataPath)
	}
	index, err := fetchClassroomsIndexFn(ctx, org)
	if err != nil {
		return nil, nil, markerlessErr("the assignment couldn't be looked up from the repository name: %w", err)
	}

	repoLower := strings.ToLower(repo)
	var candidates []string
	for _, room := range index {
		short := strings.ToLower(strings.TrimSpace(room.ShortName))
		if short != "" && strings.HasPrefix(repoLower, short+"-") {
			candidates = append(candidates, room.ShortName)
		}
	}
	if len(candidates) == 0 {
		return nil, nil, markerlessErr("%q doesn't start with any published classroom's short name, so this doesn't look like a Classroom 50 assignment repository; if it is one, commit and `git push` directly and ask your teacher to check the classroom is published", repo)
	}

	var (
		matches   []repoNameMatch
		unlisted  []string
		wrongKey  []string
		lookupErr error
	)
	for _, classroom := range candidates {
		entries, err := fetchManifestFn(ctx, org, classroom, key)
		switch {
		case err == nil:
			matches = append(matches, matchAssignmentRepo(repoLower, classroom, entries)...)
		case assignments.IsManifestNotFound(err) && key == "":
			// Unpublished, or protected and fetched without its key. Decided
			// after the other candidates: a plain classroom may still match.
			unlisted = append(unlisted, classroom)
		case assignments.IsManifestNotFound(err):
			// The manifest was fetched under the key and isn't there: the key
			// doesn't open this classroom (or the classroom is plain, in
			// which case another candidate may still match).
			wrongKey = append(wrongKey, classroom)
		default:
			lookupErr = err
		}
	}

	matches = longestPrefixMatches(matches)
	switch {
	case len(matches) == 1:
		m := matches[0]
		if verbose {
			u.Detail("Resolved %s/%s from the repository name", m.classroom, m.entry.Slug)
		}
		return configFromMatch(m, key), &m.entry, nil
	case len(matches) > 1:
		names := make([]string, 0, len(matches))
		for _, m := range matches {
			names = append(names, m.classroom+"/"+m.entry.Slug)
		}
		return nil, nil, markerlessErr("the repository name %q matches more than one published assignment (%s); ask your teacher which one this repository belongs to", repo, strings.Join(names, ", "))
	case lookupErr != nil:
		return nil, nil, markerlessErr("the assignment couldn't be looked up from the repository name: %w", lookupErr)
	case len(wrongKey) > 0:
		return nil, nil, markerlessErr("classroom %q has no assignment list under the access key you passed; double-check the key your teacher gave you, or omit --key if the classroom isn't unlisted", wrongKey[0])
	case len(unlisted) > 0:
		return nil, nil, markerlessErr("classroom %q uses an unlisted URL, so its assignment list needs the access key your teacher gave you; run `gh student submit --key <key>`", unlisted[0])
	default:
		return nil, nil, markerlessErr("%q doesn't match any assignment published for classroom %q; if this repository was created by hand, commit and `git push` directly, otherwise ask your teacher", repo, candidates[0])
	}
}

// refuseStaleMarkerlessClone stops a markerless clone whose remote already
// carries the marker. That shape is a clone taken before the teacher's
// enable-autograder backfill: submit snapshots the local tree onto a fresh
// clone of the remote, so pushing would delete the backfilled marker and
// autograde workflow and report success. A plain `git push` from the same
// clone would conflict; this is the equivalent stop.
func refuseStaleMarkerlessClone(client githubapi.Client, owner, repo string) error {
	exists, err := remoteFileExistsFn(client, owner, repo, classroomcfg.MetadataPath)
	if err != nil {
		return fmt.Errorf("check whether %s/%s already has %s: %w", owner, repo, classroomcfg.MetadataPath, err)
	}
	if exists {
		return fmt.Errorf("this repository was updated by your teacher (it now carries %s), but your clone doesn't have that change yet; run `git pull`, then `gh student submit` again", classroomcfg.MetadataPath)
	}
	return nil
}

// matchAssignmentRepo returns every entry of one classroom whose repo-name
// prefix (current slug, or the slug it was renamed from) the lowercased repo
// name carries.
func matchAssignmentRepo(repoLower, classroom string, entries []assignments.Entry) []repoNameMatch {
	var out []repoNameMatch
	for _, entry := range entries {
		for _, slug := range []string{entry.Slug, entry.RenamedFrom} {
			if slug == "" {
				continue
			}
			prefix := reponame.Prefix(classroom, slug)
			if strings.HasPrefix(repoLower, prefix) {
				out = append(out, repoNameMatch{classroom: classroom, entry: entry, prefix: prefix})
				break
			}
		}
	}
	return out
}

// longestPrefixMatches keeps only the matches with the longest prefix. One
// survivor is an unambiguous resolution; several means two classroom/slug
// pairs compose to the same prefix ("a" + "b-c" and "a-b" + "c"), which the
// name alone can't settle.
func longestPrefixMatches(matches []repoNameMatch) []repoNameMatch {
	if len(matches) < 2 {
		return matches
	}
	sort.SliceStable(matches, func(i, j int) bool {
		return len(matches[i].prefix) > len(matches[j].prefix)
	})
	best := len(matches[0].prefix)
	end := 1
	for end < len(matches) && len(matches[end].prefix) == best {
		end++
	}
	return matches[:end]
}

// configFromMatch synthesizes the marker submit would otherwise have read.
// The template becomes the teacher-file source only for a shape that would
// have carried a marker: a no_autograder or empty_repo assignment promises
// repos free of Classroom 50 writes, so submit leaves their .gitignore and
// .github alone.
func configFromMatch(m repoNameMatch, key string) *classroomcfg.Config {
	cfg := &classroomcfg.Config{
		Classroom:  m.classroom,
		Assignment: m.entry.Slug,
		Secret:     key,
	}
	if m.entry.CommitsShim() && m.entry.HasTemplate() {
		cfg.Source = &classroomcfg.Source{
			Owner:  m.entry.Template.Owner,
			Repo:   m.entry.Template.Repo,
			Branch: m.entry.Template.Branch,
		}
	}
	return cfg
}
