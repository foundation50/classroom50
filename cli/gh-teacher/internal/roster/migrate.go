package roster

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/validate"
)

func rosterMigrateCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "migrate <org> <classroom>",
		Short: "Rename a legacy students.csv to roster.csv (one commit)",
		Long: "Rename <org>/classroom50/<classroom>/students.csv to roster.csv\n" +
			"in a single Tree commit (write roster.csv with the existing bytes,\n" +
			"delete students.csv). The roster file was renamed from students.csv\n" +
			"to roster.csv; reads already fall back to the old name, so this\n" +
			"command is optional cleanup that converges an existing classroom.\n\n" +
			"Idempotent: if roster.csv already exists (and students.csv is gone),\n" +
			"this exits 0 with an 'already migrated' note and writes nothing.",
		Example: "  gh teacher roster migrate cs50-fall-2026 cs-principles",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true
			org := strings.TrimSpace(args[0])
			classroom := strings.TrimSpace(args[1])
			if org == "" || classroom == "" {
				return errors.New("org and classroom must both be non-empty")
			}
			if err := validate.ShortName(classroom, "classroom"); err != nil {
				return err
			}
			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runRosterMigrate(client, cmd.OutOrStdout(), org, classroom)
		},
	}
	return cmd
}

// runRosterMigrate renames students.csv → roster.csv in one commit. It reads
// the current state at each rebase attempt so a concurrent edit can't strand a
// partially-migrated classroom, and no-ops when there is nothing to migrate.
func runRosterMigrate(client githubapi.Client, out io.Writer, org, classroom string) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, org)
	if err != nil {
		return err
	}

	rosterPath := configrepo.RosterFilePath(classroom)
	legacyPath := configrepo.LegacyRosterFilePath(classroom)

	var alreadyMigrated bool
	build := func(parentSHA string) (configwrite.CommitChange, error) {
		alreadyMigrated = false

		// Derive both files' presence from ONE tree listing at parentSHA rather
		// than two independent contents GETs: the Trees API is a consistent
		// point-in-time snapshot of the commit, so a spurious/consistency-lag
		// 404 on a single contents path can't flip the branch we pick (e.g.
		// declaring "already migrated" and leaving students.csv behind, or
		// erroring "nothing to migrate" on a classroom that has data).
		blobs, err := configrepo.ListSubtreeBlobPaths(
			client, org, configrepo.ConfigRepoName, parentSHA, classroom)
		if err != nil {
			return configwrite.CommitChange{}, err
		}
		var legacyOK, rosterExists bool
		for _, p := range blobs {
			switch p {
			case legacyPath:
				legacyOK = true
			case rosterPath:
				rosterExists = true
			}
		}

		switch {
		case !legacyOK && rosterExists:
			// Nothing to rename — the classroom already uses roster.csv.
			alreadyMigrated = true
			return configwrite.CommitChange{}, nil
		case !legacyOK && !rosterExists:
			return configwrite.CommitChange{}, fmt.Errorf(
				"%s/%s/%s not found — nothing to migrate (run `gh teacher classroom add %s %s` first if this classroom is missing)",
				org, configrepo.ConfigRepoName, legacyPath, org, classroom)
		}

		// Legacy file present. Prefer an already-written roster.csv when both
		// exist (a prior partial run or a concurrent write) so migration never
		// clobbers newer canonical content; either way the legacy file is
		// dropped. Otherwise carry the legacy bytes onto roster.csv verbatim.
		change := configwrite.CommitChange{Deletes: []string{legacyPath}}
		if !rosterExists {
			legacyData, legacyReadOK, err := configrepo.ReadFileContents(
				client, org, configrepo.ConfigRepoName, legacyPath, parentSHA)
			if err != nil {
				return configwrite.CommitChange{}, err
			}
			if !legacyReadOK {
				// The tree listing saw the legacy blob at parentSHA but the
				// contents read 404'd — a genuine race (a concurrent migrate/
				// edit moved it) or a transient blip. Fail loud rather than
				// commit an empty roster.csv; the rebase loop retries against
				// fresh state.
				return configwrite.CommitChange{}, fmt.Errorf(
					"%s/%s/%s vanished between tree listing and read — retrying",
					org, configrepo.ConfigRepoName, legacyPath)
			}
			change.Upserts = map[string]string{rosterPath: string(legacyData)}
		}
		return change, nil
	}

	message := contract.PrefixCommit(fmt.Sprintf("roster: migrate %s to roster.csv (gh teacher roster migrate)", classroom))
	sha, err := configwrite.CommitTreeChange(client, org, configrepo.ConfigRepoName, branch, message, build)
	if err != nil {
		return err
	}

	if alreadyMigrated || sha == "" {
		_, _ = fmt.Fprintf(out, "%s/%s/%s: already migrated (roster.csv present, nothing to do)\n",
			org, configrepo.ConfigRepoName, rosterPath)
		return nil
	}
	_, _ = fmt.Fprintf(out, "%s/%s/%s: migrated %s → roster.csv\n",
		org, configrepo.ConfigRepoName, rosterPath, contract.LegacyRosterFilename)
	return nil
}
