package ui

// Status is the outcome of a read-only check, picking the result banner's
// glyph/tag. Its string values ("ok"/"warn"/"fail") are part of the --json
// contract, so they must not change.
type Status string

const (
	StatusOK   Status = "ok"
	StatusWarn Status = "warn"
	StatusFail Status = "fail"
)
