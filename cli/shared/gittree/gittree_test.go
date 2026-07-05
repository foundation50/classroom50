package gittree

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestDeletionEntriesMarshalNullSHA pins the wire contract the Trees API
// depends on: a deletion entry serializes `"sha":null`, an upsert entry a
// string SHA.
func TestDeletionEntriesMarshalNullSHA(t *testing.T) {
	entries := DeletionEntries([]string{"b/2.txt", "a/1.txt"})
	if len(entries) != 2 {
		t.Fatalf("len = %d, want 2", len(entries))
	}
	// Sorted for a deterministic payload.
	if entries[0].Path != "a/1.txt" || entries[1].Path != "b/2.txt" {
		t.Errorf("paths not sorted: %q, %q", entries[0].Path, entries[1].Path)
	}
	data, err := json.Marshal(entries[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"sha":null`) {
		t.Errorf("deletion entry = %s, want \"sha\":null", data)
	}

	// An upsert entry (non-nil SHA) must NOT be null.
	sha := "abc123"
	up := TreeEntry{Path: "x", Mode: "100644", Type: "blob", SHA: &sha}
	updata, _ := json.Marshal(up)
	if strings.Contains(string(updata), `"sha":null`) {
		t.Errorf("upsert entry = %s, want a string sha", updata)
	}

	if DeletionEntries(nil) != nil {
		t.Error("DeletionEntries(nil) should be nil")
	}
}

func TestIsNonFastForwardMessage(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		// Real shape GitHub returns.
		{"Update is not a fast forward", true},
		// Tolerate hyphenated rewordings.
		{"Update is not a fast-forward", true},
		{"UPDATE IS NOT A FAST FORWARD", true},
		// Other 422 reasons must NOT match — mis-retrying them would
		// busy-loop the rebase path.
		{"Reference does not exist", false},
		{"Resource not accessible by integration", false},
		{"Validation failed", false},
		{"", false},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := isNonFastForwardMessage(tc.in); got != tc.want {
				t.Fatalf("isNonFastForwardMessage(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
