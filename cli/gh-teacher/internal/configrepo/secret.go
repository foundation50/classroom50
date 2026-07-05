package configrepo

import (
	"crypto/rand"
	"fmt"
	"regexp"

	"github.com/foundation50/classroom50-cli-shared/contract"
)

// SecretAlphabet is the character set for a generated capability-URL secret:
// lowercase letters and digits, so it composes cleanly into the Pages path
// `<classroom>/<secret>/...`.
const SecretAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

// DefaultSecretLength is the generated length when the teacher opts in without
// a value. 8 chars of [a-z0-9] is ~41 bits — ample for anti-discovery friction.
const DefaultSecretLength = 8

// SecretPattern bounds a capability-URL secret to one safe path segment
// (4-64 lowercase-alnum), compiled from the single-sourced contract.SecretPattern.
var SecretPattern = regexp.MustCompile(contract.SecretPattern)

// SecretPatternDescription is the human-readable summary embedded in the
// "invalid secret" error.
const SecretPatternDescription = contract.SecretPatternDescription

// ValidateSecret checks a secret against SecretPattern. An empty secret is
// rejected; callers allowing "no secret" must branch on emptiness first.
func ValidateSecret(secret string) error {
	if !SecretPattern.MatchString(secret) {
		return fmt.Errorf("invalid secret %q: must be %s", secret, SecretPatternDescription)
	}
	return nil
}

// GenerateSecret returns a cryptographically random n-char secret from
// SecretAlphabet, using rejection sampling to avoid modulo bias.
func GenerateSecret(n int) (string, error) {
	if n <= 0 {
		return "", fmt.Errorf("secret length must be positive, got %d", n)
	}
	out := make([]byte, n)
	// max is the largest multiple of the alphabet size that fits in a byte;
	// bytes >= max would bias low residues, so reject and redraw.
	max := byte(256 - (256 % len(SecretAlphabet)))
	buf := make([]byte, 1)
	for i := 0; i < n; {
		if _, err := rand.Read(buf); err != nil {
			return "", fmt.Errorf("read random bytes: %w", err)
		}
		if buf[0] >= max {
			continue
		}
		out[i] = SecretAlphabet[int(buf[0])%len(SecretAlphabet)]
		i++
	}
	return string(out), nil
}
