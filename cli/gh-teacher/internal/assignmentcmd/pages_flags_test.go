package assignmentcmd

import (
	"reflect"
	"strings"
	"testing"

	"github.com/foundation50/gh-teacher/internal/assignment"
)

func TestParsePagesFlags(t *testing.T) {
	cases := []struct {
		name               string
		source, branch     string
		path               string
		branchSet, pathSet bool
		want               *assignment.PagesConfig
		wantErr            string
	}{
		{name: "default off", source: "off", path: "/"},
		{name: "empty is off", source: "", path: "/"},
		{name: "workflow", source: "workflow", path: "/", want: &assignment.PagesConfig{Source: "workflow"}},
		{name: "branch default", source: "branch", path: "/", want: &assignment.PagesConfig{Source: "branch"}},
		{name: "branch named docs", source: "branch", branch: "gh-pages", path: "/docs", branchSet: true, pathSet: true,
			want: &assignment.PagesConfig{Source: "branch", Branch: "gh-pages", Path: "/docs"}},
		{name: "root path collapses", source: "branch", path: "/", pathSet: true, want: &assignment.PagesConfig{Source: "branch"}},
		{name: "unknown source", source: "legacy", path: "/", wantErr: "--pages must be one of off, workflow, branch"},
		{name: "off with branch", source: "off", branch: "main", path: "/", branchSet: true, wantErr: "require --pages branch"},
		{name: "workflow with path", source: "workflow", path: "/docs", pathSet: true, wantErr: "only apply with --pages branch"},
		{name: "bad path", source: "branch", path: "/site", pathSet: true, wantErr: "pages.path"},
		{name: "padded branch trimmed", source: "branch", branch: " main ", path: "/", branchSet: true,
			want: &assignment.PagesConfig{Source: "branch", Branch: "main"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parsePagesFlags(tc.source, tc.branch, tc.path, tc.branchSet, tc.pathSet)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want it to contain %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}
