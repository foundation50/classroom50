package cliutil

import (
	"errors"
	"strings"

	"github.com/foundation50/gh-teacher/internal/validate"
)

// AssignmentScope is the validated `<org> <classroom> <assignment>` triple the
// assignment-scoped command groups (`team`, `group`) take as positional args.
type AssignmentScope struct {
	Org        string
	Classroom  string
	Assignment string
}

// ParseAssignmentScope validates the first three positional args as a scope.
// Subcommands with extra positional args pass the full slice.
func ParseAssignmentScope(args []string) (AssignmentScope, error) {
	if len(args) < 3 {
		return AssignmentScope{}, errors.New("org, classroom, and assignment are required")
	}
	scope := AssignmentScope{
		Org:        strings.TrimSpace(args[0]),
		Classroom:  strings.TrimSpace(args[1]),
		Assignment: strings.TrimSpace(args[2]),
	}
	if scope.Org == "" || scope.Classroom == "" || scope.Assignment == "" {
		return AssignmentScope{}, errors.New("org, classroom, and assignment must all be non-empty")
	}
	if err := validate.ShortName(scope.Classroom, "classroom"); err != nil {
		return AssignmentScope{}, err
	}
	if err := validate.ShortName(scope.Assignment, "assignment"); err != nil {
		return AssignmentScope{}, err
	}
	return scope, nil
}
