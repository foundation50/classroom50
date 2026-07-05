package main

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/servicetoken"
)

// provisionServiceToken handles the service-token step of init with a
// minimal-prompt UX:
//   - env var set: validate, store, note it was used.
//   - secret exists (re-run) and no env var: skip; tell the teacher how to
//     replace it.
//   - first-time, no env var: prompt, validate (BLOCKING), store.
//
// Every non-prompt path prints a note so a re-run explains why no token was
// asked for. secretExists is what preflight already fetched. Stays in package
// main because it writes *initSummary.
func provisionServiceToken(cmd *cobra.Command, client githubapi.Client, summary *initSummary, org string, secretExists bool) error {
	errOut := cmd.ErrOrStderr()

	// 1. Env var wins (CI / scripted / explicit refresh).
	if v := strings.TrimSpace(os.Getenv(servicetoken.EnvServiceToken)); v != "" {
		token := []byte(v)
		if err := servicetoken.ValidateTokenVerbose(token, org, errOut); err != nil {
			return fmt.Errorf("the %s in your environment failed validation: %w", servicetoken.EnvServiceToken, err)
		}
		if err := servicetoken.ProvisionSecret(client, io.Discard, org, configrepo.ConfigRepoName, token, "stored"); err != nil {
			return err
		}
		summary.ServiceToken = "configured from " + servicetoken.EnvServiceToken
		_, _ = fmt.Fprintf(errOut, "Service token: configured from $%s.\n", servicetoken.EnvServiceToken)
		return nil
	}

	// 2. Re-run with the secret already present: don't re-prompt.
	if secretExists {
		summary.ServiceToken = "already configured"
		_, _ = fmt.Fprintf(errOut, "Service token: already configured — left as-is. To replace it, run `gh teacher rotate-service-token %s` (or set %s and re-run).\n", org, servicetoken.EnvServiceToken)
		return nil
	}

	// 3. First-time setup: prompt, validate (blocking), store.
	token, err := servicetoken.ReadToken(cmd)
	if err != nil {
		return err
	}
	if err := servicetoken.ValidateTokenVerbose(token, org, errOut); err != nil {
		return fmt.Errorf("service token validation failed: %w", err)
	}
	if err := servicetoken.ProvisionSecret(client, io.Discard, org, configrepo.ConfigRepoName, token, "stored"); err != nil {
		return err
	}
	summary.ServiceToken = "configured (prompted)"
	_, _ = fmt.Fprintf(errOut, "Service token: validated and stored as the %s secret.\n", servicetoken.SecretName)
	return nil
}
