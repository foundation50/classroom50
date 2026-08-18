package cliutil

import "errors"

// ExitCodeError carries a specific process exit code out of a cobra RunE, for
// the few commands whose exit status is a machine-readable RESULT rather than
// just success/failure (`roster sync` defines the one such contract today).
//
// Err still carries the message cobra prints, so a non-failure code must wrap a
// sentence that reads as a report rather than a fault.
type ExitCodeError struct {
	Code int
	Err  error
}

func (e *ExitCodeError) Error() string {
	if e.Err == nil {
		return ""
	}
	return e.Err.Error()
}

func (e *ExitCodeError) Unwrap() error { return e.Err }

// ExitCodeFor maps a command error to a process exit code: 0 for no error, the
// carried code for an *ExitCodeError, and 1 for every ordinary failure — so a
// command that opts out of the contract keeps the historical behaviour.
func ExitCodeFor(err error) int {
	if err == nil {
		return 0
	}
	var coded *ExitCodeError
	if errors.As(err, &coded) {
		return coded.Code
	}
	return 1
}
