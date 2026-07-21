package assignment

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestValidateReleaseAssets(t *testing.T) {
	valid := [][]string{
		nil,
		{},
		{"report.pdf", "plots/chart.png", ".github/summary.txt"},
		{"generated*/report.pdf", "plots[2026]/chart.png"},
		{"nested/.git/report.pdf", "résumés 2026/summary.txt"},
		{"archive..old/report.pdf"},
		{"a/report.pdf", "b/Report.pdf"},
		{strings.Repeat("a", 251) + ".pdf"},
	}
	for _, paths := range valid {
		if err := ValidateReleaseAssets(paths); err != nil {
			t.Errorf("ValidateReleaseAssets(%q): %v", paths, err)
		}
	}

	invalid := [][]string{
		{""}, {"  "}, {"/tmp/report.pdf"}, {"C:/report.pdf"},
		{`plots\\chart.png`}, {"plots//chart.png"}, {"./report.pdf"},
		{"plots/./chart.png"}, {"../report.pdf"}, {"plots/../report.pdf"},
		{"plots/"}, {"a\nreport.pdf"}, {"a\rreport.pdf"}, {"a\x7freport.pdf"},
		{"a\u0085report.pdf"},
		{".git/report.pdf"}, {".GiT/report.pdf"}, {".report.pdf"},
		{"report.pdf."}, {"*.pdf"}, {"résumé.pdf"},
		{strings.Repeat("a", 252) + ".pdf"},
		{"result.json"}, {"nested/RESULT.JSON"},
		{"release-body.md"}, {"nested/Release-Body.MD"},
		{"report..pdf"},
		{"report.pdf", "report.pdf"},
		{"one/report.pdf", "two/report.pdf"},
	}
	for _, paths := range invalid {
		if err := ValidateReleaseAssets(paths); err == nil {
			t.Errorf("ValidateReleaseAssets(%q) unexpectedly succeeded", paths)
		}
	}
}

func TestValidateReleaseAssetsTotalPathBytes(t *testing.T) {
	p1 := strings.Repeat("a", 4094) + "/x"
	exactP2 := strings.Repeat("é", 2047) + "/y"
	if err := ValidateReleaseAssets([]string{p1, exactP2}); err != nil {
		t.Fatalf("8192 aggregate UTF-8 path bytes: %v", err)
	}

	overP2 := strings.Repeat("é", 2047) + "z/y"
	if err := ValidateReleaseAssets([]string{p1, overP2}); err == nil {
		t.Fatal("expected aggregate UTF-8 path-byte error at 8193 bytes")
	}
}

func TestValidateReleaseAssetsCap(t *testing.T) {
	paths := make([]string, 50)
	for i := range paths {
		paths[i] = fmt.Sprintf("f%d.pdf", i)
	}
	if err := ValidateReleaseAssets(paths); err != nil {
		t.Fatalf("exact cap: %v", err)
	}
	paths = append(paths, "overflow.pdf")
	if err := ValidateReleaseAssets(paths); err == nil {
		t.Fatal("expected over-cap error")
	}
}

func TestAssignmentEntryCanonicalizesReleaseAssets(t *testing.T) {
	for _, raw := range []string{
		`{"slug":"s","name":"n","mode":"individual","autograder":"default"}`,
		`{"slug":"s","name":"n","mode":"individual","autograder":"default","release_assets":null}`,
		`{"slug":"s","name":"n","mode":"individual","autograder":"default","release_assets":[]}`,
	} {
		var entry AssignmentEntry
		if err := json.Unmarshal([]byte(raw), &entry); err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(entry)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), "release_assets") {
			t.Fatalf("empty field was not omitted: %s", encoded)
		}
	}

	raw := `{"slug":"s","name":"n","mode":"individual","autograder":"default","release_assets":["report.pdf","plots/chart.png"]}`
	var entry AssignmentEntry
	if err := json.Unmarshal([]byte(raw), &entry); err != nil {
		t.Fatal(err)
	}
	if _, ok := entry.Extra["release_assets"]; ok {
		t.Fatal("release_assets must be typed, not Extra")
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"release_assets":["report.pdf","plots/chart.png"]`) {
		t.Fatalf("ordered field did not round-trip: %s", encoded)
	}
}

func TestParseAssignmentsRejectsInvalidReleaseAssets(t *testing.T) {
	invalid := []byte(`{
  "schema":"classroom50/assignments/v1",
  "assignments":[{
    "slug":"ss","name":"n","mode":"individual","autograder":"default",
    "release_assets":["a/report.pdf","b/report.pdf"]
  }]
}`)
	if _, err := ParseAssignments(invalid); err == nil {
		t.Fatal("expected semantic release_assets error on parse")
	}

	valid := []byte(`{
  "schema":"classroom50/assignments/v1",
  "assignments":[{
    "slug":"ss","name":"n","mode":"individual","autograder":"default",
    "release_assets":["report.pdf","plots/chart.png"]
  }]
}`)
	parsed, err := ParseAssignments(valid)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := EncodeAssignments(parsed)
	if err != nil {
		t.Fatal(err)
	}
	again, err := ParseAssignments(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(
		again.Assignments[0].ReleaseAssets,
		[]string{"report.pdf", "plots/chart.png"},
	) {
		t.Fatalf("round-trip release_assets = %#v", again.Assignments[0].ReleaseAssets)
	}
}

func TestParseAssignmentsRejectsUnpairedReleaseAssetSurrogates(t *testing.T) {
	for _, escapedPath := range []string{`\ud800/report.pdf`, `\udc00/report.pdf`} {
		raw := fmt.Sprintf(`{
  "schema":"classroom50/assignments/v1",
  "assignments":[{
    "slug":"ss","name":"n","mode":"individual","autograder":"default",
    "release_assets":["%s"]
  }]
}`, escapedPath)
		if _, err := ParseAssignments([]byte(raw)); err == nil || !strings.Contains(err.Error(), "surrogate") {
			t.Fatalf("ParseAssignments(%q) error = %v, want surrogate rejection", escapedPath, err)
		}
	}

	validPair := []byte(`{
  "schema":"classroom50/assignments/v1",
  "assignments":[{
    "slug":"ss","name":"n","mode":"individual","autograder":"default",
    "release_assets":["\ud83d\ude00/report.pdf"]
  }]
}`)
	if _, err := ParseAssignments(validPair); err != nil {
		t.Fatalf("valid surrogate pair: %v", err)
	}
}
