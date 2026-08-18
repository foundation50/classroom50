package cliutil

import (
	"errors"
	"fmt"
	"testing"
)

// TestExitCodeFor pins the mapping main() applies: only a command that opts
// into a coded result gets a non-1 failure status, and a coded error still
// reaches errors.Is/As through the wrap.
func TestExitCodeFor(t *testing.T) {
	sentinel := errors.New("degraded")
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"no error", nil, 0},
		{"ordinary failure", errors.New("boom"), 1},
		{"coded changes-pending", &ExitCodeError{Code: 2, Err: errors.New("pending")}, 2},
		{"coded degraded", &ExitCodeError{Code: 1, Err: sentinel}, 1},
		{"wrapped coded error", fmt.Errorf("context: %w", &ExitCodeError{Code: 2}), 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ExitCodeFor(tc.err); got != tc.want {
				t.Errorf("ExitCodeFor(%v) = %d, want %d", tc.err, got, tc.want)
			}
		})
	}

	coded := &ExitCodeError{Code: 1, Err: sentinel}
	if !errors.Is(coded, sentinel) {
		t.Error("a coded error must not hide the cause it wraps")
	}
	if got := coded.Error(); got != "degraded" {
		t.Errorf("Error() = %q, want the wrapped message", got)
	}
}
