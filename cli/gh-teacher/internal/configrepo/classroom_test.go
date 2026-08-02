package configrepo

import (
	"encoding/json"
	"strings"
	"testing"
)

func boolPtr(b bool) *bool { return &b }

func TestClassroomJSON_IsArchived(t *testing.T) {
	cases := []struct {
		name   string
		active *bool
		want   bool
	}{
		{"absent active = active (legacy classroom)", nil, false},
		{"active:true = active", boolPtr(true), false},
		{"active:false = archived", boolPtr(false), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &ClassroomJSON{Schema: "classroom50/classroom/v1", Active: tc.active}
			if got := c.IsArchived(); got != tc.want {
				t.Errorf("IsArchived() = %v, want %v", got, tc.want)
			}
		})
	}
	if (*ClassroomJSON)(nil).IsArchived() {
		t.Errorf("nil ClassroomJSON must not report archived")
	}
}

// TestClassroomJSON_ActiveRoundTrip pins the omitempty wire contract:
// an absent/true active never serializes the key (so a legacy classroom
// reads identically), while archiving stamps `"active": false`.
func TestClassroomJSON_ActiveRoundTrip(t *testing.T) {
	t.Run("active classroom (nil) omits the key", func(t *testing.T) {
		// The CLI only ever writes nil (unarchive clears the flag) or
		// false (archive); it never writes an explicit true, so a
		// CLI-written active classroom omits the key entirely — the
		// omitempty-clean wire contract that keeps a re-activated
		// classroom byte-identical to a never-archived one.
		c := ClassroomJSON{Schema: "classroom50/classroom/v1", Name: "n", ShortName: "s", Term: "", Org: "o", Active: nil}
		data, err := json.Marshal(c)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if strings.Contains(string(data), "active") {
			t.Errorf("nil active should omit the key, got %s", data)
		}
	})

	t.Run("explicit active:true reads as active", func(t *testing.T) {
		// A web client may write active:true explicitly; it must still
		// read as active (not archived) so the binaries agree.
		var back ClassroomJSON
		if err := json.Unmarshal([]byte(`{"schema":"classroom50/classroom/v1","name":"n","short_name":"s","org":"o","active":true}`), &back); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if back.IsArchived() {
			t.Errorf("active:true must read as active, not archived")
		}
	})

	t.Run("archived classroom round-trips active:false", func(t *testing.T) {
		c := ClassroomJSON{Schema: "classroom50/classroom/v1", Name: "n", ShortName: "s", Org: "o", Active: boolPtr(false)}
		data, err := json.Marshal(c)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if !strings.Contains(string(data), `"active":false`) {
			t.Errorf("archived classroom should emit active:false, got %s", data)
		}
		var back ClassroomJSON
		if err := json.Unmarshal(data, &back); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if !back.IsArchived() {
			t.Errorf("round-tripped classroom should still be archived")
		}
	})
}

// TestClassroomJSON_PreservesUnknownField pins the "tolerate AND preserve"
// rule for classroom.json: an unknown top-level key (one a newer binary or
// the web GUI wrote before this CLI models it) must NOT fail the decode and
// must round-trip verbatim, so an archive/unarchive/edit read-modify-write
// never drops it.
func TestClassroomJSON_PreservesUnknownField(t *testing.T) {
	in := []byte(`{"schema":"classroom50/classroom/v1","name":"n","short_name":"s","term":"","org":"o","lms_link":{"url":"https://lms.example/c/1"},"future_flag":true}`)
	var c ClassroomJSON
	if err := json.Unmarshal(in, &c); err != nil {
		t.Fatalf("unmarshal must tolerate unknown classroom keys: %v", err)
	}
	if c.Extra == nil {
		t.Fatalf("unknown fields should be captured into Extra, got nil")
	}
	if _, ok := c.Extra["lms_link"]; !ok {
		t.Errorf("lms_link not captured into Extra: %v", c.Extra)
	}

	// Re-encode (the archive/unarchive/edit write path) and confirm the
	// unknown keys survive verbatim.
	out, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(out), "lms_link") || !strings.Contains(string(out), "future_flag") {
		t.Errorf("re-encoded classroom dropped an unknown field: %s", out)
	}
	if string(c.Extra["future_flag"]) != "true" {
		t.Errorf("future_flag not preserved verbatim: %s", c.Extra["future_flag"])
	}

	var back ClassroomJSON
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatalf("re-parse of re-encoded classroom: %v\n%s", err, out)
	}
	if _, ok := back.Extra["lms_link"]; !ok {
		t.Errorf("lms_link lost on round-trip: %v", back.Extra)
	}
}

// TestClassroomJSON_MarshalOrdering pins that MarshalJSON keeps the known
// fields before any Extra keys (the splice-after-known-fields contract) and
// sorts the Extra keys deterministically.
func TestClassroomJSON_MarshalOrdering(t *testing.T) {
	c := ClassroomJSON{
		Schema: "classroom50/classroom/v1", Name: "n", ShortName: "s", Term: "", Org: "o",
		Extra: map[string]json.RawMessage{
			"zeta":  json.RawMessage(`1`),
			"alpha": json.RawMessage(`2`),
		},
	}
	out, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(out)
	// A known field precedes every preserved key.
	if strings.Index(s, `"schema"`) >= strings.Index(s, `"alpha"`) {
		t.Errorf("known field should precede Extra keys: %s", s)
	}
	// Extra keys are alphabetically sorted (alpha before zeta).
	if strings.Index(s, `"alpha"`) >= strings.Index(s, `"zeta"`) {
		t.Errorf("Extra keys should be sorted (alpha before zeta): %s", s)
	}
}

// TestClassroomJSON_NoExtraOmitsCleanly confirms a classroom with no Extra
// marshals exactly as the plain struct would (no trailing comma / brace
// artifacts from the splice path).
func TestClassroomJSON_NoExtraOmitsCleanly(t *testing.T) {
	c := ClassroomJSON{Schema: "classroom50/classroom/v1", Name: "n", ShortName: "s", Term: "", Org: "o"}
	out, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back ClassroomJSON
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatalf("re-parse: %v\n%s", err, out)
	}
	if back.Extra != nil {
		t.Errorf("no-Extra classroom should round-trip with nil Extra, got %v", back.Extra)
	}
}

// TestClassroomJSON_TeamsRoundTrip pins that the web-authored `teams` block
// decodes into the typed Teams field (NOT Extra) and survives a
// read-modify-write verbatim.
func TestClassroomJSON_TeamsRoundTrip(t *testing.T) {
	in := []byte(`{"schema":"classroom50/classroom/v1","name":"n","short_name":"cs101","term":"","org":"o","teams":{"teacher":{"id":11,"slug":"classroom50-cs101-teacher"},"ta":{"id":12,"slug":"classroom50-cs101-ta"}}}`)
	var c ClassroomJSON
	if err := json.Unmarshal(in, &c); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// teams is a known field, so it must NOT be diverted to Extra.
	if c.Extra != nil {
		if _, leaked := c.Extra["teams"]; leaked {
			t.Errorf("teams should decode into the typed field, not Extra: %v", c.Extra)
		}
	}
	if c.Teams == nil || c.Teams.Teacher == nil || c.Teams.TA == nil {
		t.Fatalf("teams not decoded into typed Teams field: %+v", c.Teams)
	}
	if c.Teams.Teacher.Slug != "classroom50-cs101-teacher" || c.Teams.Teacher.ID != 11 {
		t.Errorf("teacher team ref wrong: %+v", c.Teams.Teacher)
	}
	if c.Teams.TA.Slug != "classroom50-cs101-ta" || c.Teams.TA.ID != 12 {
		t.Errorf("ta team ref wrong: %+v", c.Teams.TA)
	}

	// Re-encode (the read-modify-write path) and confirm the block survives.
	out, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back ClassroomJSON
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatalf("re-parse: %v\n%s", err, out)
	}
	if back.Teams == nil || back.Teams.Teacher == nil || back.Teams.TA == nil {
		t.Errorf("teams lost on round-trip: %s", out)
	}
}

// TestClassroomJSON_NoTeamsOmitsKey confirms a classroom without staff teams
// never serializes a `teams` key (the omitempty contract).
func TestClassroomJSON_NoTeamsOmitsKey(t *testing.T) {
	c := ClassroomJSON{Schema: "classroom50/classroom/v1", Name: "n", ShortName: "s", Term: "", Org: "o"}
	out, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(out), "teams") {
		t.Errorf("classroom with no staff teams should omit the teams key: %s", out)
	}
}
