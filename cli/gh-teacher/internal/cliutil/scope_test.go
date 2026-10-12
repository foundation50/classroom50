package cliutil

import (
	"strings"
	"testing"
)

func TestParseAssignmentScope(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		want    AssignmentScope
		wantErr string
	}{
		{
			name: "trims and keeps the first three args",
			args: []string{" org ", " cs101 ", " hw1 ", "extra"},
			want: AssignmentScope{Org: "org", Classroom: "cs101", Assignment: "hw1"},
		},
		{
			name:    "fewer than three args",
			args:    []string{"org", "cs101"},
			wantErr: "are required",
		},
		{
			name:    "blank arg after trimming",
			args:    []string{"org", "  ", "hw1"},
			wantErr: "must all be non-empty",
		},
		{
			name:    "classroom fails short-name validation",
			args:    []string{"org", "cs 101", "hw1"},
			wantErr: "classroom",
		},
		{
			name:    "assignment fails short-name validation",
			args:    []string{"org", "cs101", "hw/1"},
			wantErr: "assignment",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseAssignmentScope(tc.args)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("scope = %+v, want %+v", got, tc.want)
			}
		})
	}
}
