package classroom

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/foundation50/classroom50-cli-shared/contract"
	"github.com/foundation50/gh-teacher/internal/assignment"
	"github.com/foundation50/gh-teacher/internal/configrepo"
	"github.com/foundation50/gh-teacher/internal/configwrite"
	"github.com/foundation50/gh-teacher/internal/githubapi"
	"github.com/foundation50/gh-teacher/internal/validate"
)

// classroomMigrateCmd implements `gh teacher classroom migrate`: reads a GitHub
// Classroom source, copies each starter repo as a fresh template in the target
// org, and commits the matching classroom directory to <target>/classroom50.
func classroomMigrateCmd() *cobra.Command {
	var (
		source          string
		target          string
		shortName       string
		term            string
		templateSuffix  string
		includeArchived bool
		dryRun          bool
	)

	cmd := &cobra.Command{
		Use:   "migrate --source <id-or-org> --target <org>",
		Short: "Migrate a classroom from GitHub Classroom into the target org's classroom50 repo",
		Long: "Migrate a classroom from the legacy GitHub Classroom product into\n" +
			"<target>/classroom50 — copies each starter repo as a fresh template\n" +
			"in the target org and registers a matching entry in\n" +
			"<short-name>/assignments.json. The roster and scores are NOT\n" +
			"migrated; teachers re-onboard students for the new term via\n" +
			"`gh teacher roster add|import`.\n\n" +
			"GitHub Classroom is 1:1 with orgs (the org IS the classroom\n" +
			"container) while Classroom 50 hosts multiple classrooms per\n" +
			"org under one classroom50 config repo. Migrating N legacy\n" +
			"classrooms into one target org means running this command N\n" +
			"times, once per source classroom.\n\n" +
			"--source accepts a numeric GitHub Classroom ID (e.g. 95884) or\n" +
			"the source org's login (e.g. classroom50test). Org-login\n" +
			"resolution errors if zero or more than one classroom matches.\n" +
			"Archived classrooms resolve when looked up by numeric ID; they\n" +
			"are skipped during org-name resolution unless --include-archived\n" +
			"is passed.\n\n" +
			"--target is the destination org where the classroom50 config\n" +
			"repo lives. Run `gh teacher init <target>` first if it doesn't\n" +
			"yet exist.\n\n" +
			"--short-name overrides the auto-derived classroom directory\n" +
			"name. Migrate slugifies the source classroom name (lowercase,\n" +
			"non-alnum → '-', collapsed, trimmed) and validates against\n" +
			"^[a-z0-9][a-z0-9-]{1,38}$. Pass --short-name explicitly if\n" +
			"the derived value fails validation.\n\n" +
			"--template-suffix appends a string to every target template\n" +
			"repo name (e.g. --template-suffix migrated → readability-migrated).\n" +
			"Use to escape collisions with existing target-org repos.\n\n" +
			"--dry-run runs discovery against the source and prints what\n" +
			"would be migrated. No API writes to either source or target.",
		Example: "  gh teacher classroom migrate --source 95884 --target cs50-fall-2026 --dry-run\n" +
			"  gh teacher classroom migrate --source classroom50test --target cs50-fall-2026 --dry-run\n" +
			"  gh teacher classroom migrate --source 95884 --target cs50-fall-2026 --dry-run \\\n" +
			"      --short-name cs-principles --term Spring-2026",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SilenceUsage = true

			sourceVal := strings.TrimSpace(source)
			targetVal := strings.TrimSpace(target)
			if sourceVal == "" {
				return errors.New("--source is required (numeric classroom ID or org login)")
			}
			if targetVal == "" {
				return errors.New("--target is required (destination org owning the classroom50 config repo)")
			}

			client, err := githubapi.RequireAuthClient(cmd)
			if err != nil {
				return err
			}
			return runMigrate(client, cmd.OutOrStdout(), cmd.ErrOrStderr(), migrateOptions{
				Source:          sourceVal,
				Target:          targetVal,
				ShortName:       strings.TrimSpace(shortName),
				Term:            strings.TrimSpace(term),
				TemplateSuffix:  strings.TrimSpace(templateSuffix),
				IncludeArchived: includeArchived,
				DryRun:          dryRun,
			})
		},
	}

	cmd.Flags().StringVar(&source, "source", "", "Source classroom — numeric ID or org login (required)")
	cmd.Flags().StringVar(&target, "target", "", "Destination org owning the classroom50 config repo (required)")
	cmd.Flags().StringVar(&shortName, "short-name", "", "Override the auto-derived classroom directory name")
	cmd.Flags().StringVar(&term, "term", "", "Set classroom.json.term (e.g. Spring-2026)")
	cmd.Flags().StringVar(&templateSuffix, "template-suffix", "", "Suffix appended to every target template repo name (e.g. --template-suffix migrated → readability-migrated)")
	cmd.Flags().BoolVar(&includeArchived, "include-archived", false, "Include archived classrooms when resolving --source by org name (ignored when --source is a numeric ID)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Print the discovered migration plan without API writes")
	return cmd
}

// migrateOptions packages runMigrate's flags so tests can call it directly.
type migrateOptions struct {
	Source          string
	Target          string
	ShortName       string
	Term            string
	TemplateSuffix  string
	IncludeArchived bool
	DryRun          bool
}

// runMigrate is the top-level orchestrator:
//
//  1. Discovery — resolve --source, derive short-name, fetch all
//     assignment details.
//  2. Pre-flight — refuse to overwrite an existing target dir.
//  3. Template copy — per-assignment generate/reuse/skip.
//  4. Config commit — single Tree commit on <target>/classroom50.
//
// DryRun short-circuits after step 1.
func runMigrate(client githubapi.Client, out, errOut io.Writer, opts migrateOptions) error {
	plan, err := discoverMigration(client, errOut, opts)
	if err != nil {
		return err
	}

	if err := printMigrationPlan(out, plan); err != nil {
		return err
	}

	if opts.DryRun {
		_, _ = fmt.Fprintln(errOut, "Dry-run complete — no API writes performed.")
		_, _ = fmt.Fprintln(errOut, "Next: re-run without --dry-run to perform the migration.")
		return nil
	}

	return performMigration(client, out, errOut, plan, opts.TemplateSuffix)
}

// discoverMigration resolves --source, derives the short-name, and fetches
// every assignment detail.
func discoverMigration(client githubapi.Client, errOut io.Writer, opts migrateOptions) (migrationPlan, error) {
	detail, err := resolveSource(client, errOut, opts.Source, opts.IncludeArchived)
	if err != nil {
		return migrationPlan{}, err
	}

	shortNameVal := opts.ShortName
	if shortNameVal == "" {
		shortNameVal, err = deriveShortName(detail.Name)
		if err != nil {
			return migrationPlan{}, err
		}
	}
	if err := validate.ShortName(shortNameVal, "short-name"); err != nil {
		return migrationPlan{}, err
	}
	// A migrated classroom gets a team (classroom50-<short>); reject a
	// short-name GitHub would slugify differently up front, before any repos
	// are generated, so ensureClassroomTeam can't hard-fail later and orphan
	// the templates. Auto-derived short-names are already canonical.
	if !configrepo.CanonicalTeamSlugShortName(shortNameVal) {
		return migrationPlan{}, fmt.Errorf("short-name %q can't back a GitHub team — remove consecutive or trailing hyphens (GitHub would rewrite the team slug, breaking membership and template grants)", shortNameVal)
	}

	assignments, err := fetchAssignmentsForClassroom(client, detail.ID)
	if err != nil {
		return migrationPlan{}, err
	}

	return migrationPlan{
		Classroom:   detail,
		Assignments: assignments,
		TargetOrg:   opts.Target,
		ShortName:   shortNameVal,
		Term:        opts.Term,
		MigratedAt:  time.Now().UTC(),
	}, nil
}

// performMigration runs template copy then a single Tree commit on
// <target>/classroom50. Returns a non-nil error when any assignment was
// skipped — best-effort: the commit lands with the successful entries and the
// non-zero exit signals partial completion.
func performMigration(client githubapi.Client, out, errOut io.Writer, plan migrationPlan, templateSuffix string) error {
	branch, err := configrepo.ResolveConfigRepoBranch(client, plan.TargetOrg)
	if err != nil {
		return err
	}

	// Fail fast on "already exists" before any template repos get created. The
	// build callback re-probes for race-safety.
	exists, err := configrepo.ContentsExists(client, plan.TargetOrg, configrepo.ConfigRepoName, plan.ShortName, branch)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("classroom %q already exists in %s/%s — pick a different --short-name or delete the dir",
			plan.ShortName, plan.TargetOrg, configrepo.ConfigRepoName)
	}

	resolved, err := runTemplateCopy(client, errOut, plan, templateSuffix)
	if err != nil {
		return err
	}

	entries := buildMigratedEntries(errOut, plan, resolved)
	migration := classroomMigratedFromFromDetail(plan.Classroom, plan.MigratedAt)

	// Create (or adopt) the per-classroom team so its ref lands in
	// classroom.json, same as `classroom add`.
	team, err := configrepo.EnsureClassroomTeam(client, plan.TargetOrg, plan.ShortName)
	if err != nil {
		return fmt.Errorf("create classroom team: %w", err)
	}

	// Re-probe existence before seeding staff teams so an already-existing
	// classroom fails fast without orphaning write-granted staff teams. The
	// in-build check is the authoritative concurrent-writer guard.
	if exists, err := configrepo.ContentsExists(client, plan.TargetOrg, configrepo.ConfigRepoName, plan.ShortName, branch); err != nil {
		return err
	} else if exists {
		return fmt.Errorf("classroom %q already exists in %s/%s — refusing to overwrite",
			plan.ShortName, plan.TargetOrg, configrepo.ConfigRepoName)
	}

	// Create (or adopt) staff teams + config-repo write grant + instructor
	// seed, same as `classroom add`.
	staffTeams, login, err := seedStaffTeams(client, errOut, plan.TargetOrg, plan.ShortName)
	if err != nil {
		return err
	}

	// Drop the acting teacher from the students + TA teams so their only role is
	// instructor — mixed roles aren't allowed, same as `classroom add`.
	dropCreatorFromNonInstructorTeams(client, errOut, plan.TargetOrg, login, team.Slug, staffTeams)

	build := func(parentSHA string) (map[string]string, error) {
		exists, err := configrepo.ContentsExists(client, plan.TargetOrg, configrepo.ConfigRepoName, plan.ShortName, parentSHA)
		if err != nil {
			return nil, err
		}
		if exists {
			return nil, fmt.Errorf("classroom %q appeared in %s/%s mid-commit (concurrent writer?)",
				plan.ShortName, plan.TargetOrg, configrepo.ConfigRepoName)
		}
		// Migrated classrooms get a plain (guessable) URL — unlisted is a
		// `classroom add --unlisted` opt-in and a bulk import can't block on
		// its prompt, so pass an empty key.
		return classroomScaffold(plan.TargetOrg, plan.ShortName, plan.Classroom.Name, plan.Term, "", entries, migration, &team, staffTeams)
	}

	message := contract.PrefixCommit(fmt.Sprintf("Migrate %s from GitHub Classroom %d (gh teacher classroom migrate)",
		plan.ShortName, plan.Classroom.ID))
	commitSHA, err := configwrite.CommitTree(client, plan.TargetOrg, configrepo.ConfigRepoName, branch, message, build)
	if err != nil {
		return err
	}

	printMigrationSummary(out, errOut, plan, resolved, entries, commitSHA, branch)

	// Grant the classroom team read on any private migrated template. A private
	// template is the in-org-private case `assignment add` handles — without
	// the grant, `student accept` 404s generating from it. Gate on the TARGET
	// repo's visibility, use the team's authoritative slug, and track failures
	// so the exit code reflects a template students can't yet accept.
	var grantFailures int
	for i := range resolved {
		rt := resolved[i]
		if rt.Action == templateActionSkipped || !rt.TargetPrivate {
			continue
		}
		granted, gerr := configrepo.GrantTeamRepoRead(client, plan.TargetOrg, team.Slug, rt.Template.Owner, rt.Template.Repo)
		if gerr != nil {
			grantFailures++
			_, _ = fmt.Fprintf(errOut, "Warning: %s: could not grant the classroom team read on private template %s/%s (%v); students will 404 on `gh student accept` until you grant it. Retry with `gh teacher assignment add` or grant the team manually.\n",
				plan.TargetOrg, rt.Template.Owner, rt.Template.Repo, gerr)
			continue
		}
		if granted {
			_, _ = fmt.Fprintf(out, "%s: granted classroom team %s read on private template %s/%s\n",
				plan.TargetOrg, team.Slug, rt.Template.Owner, rt.Template.Repo)
		}
	}

	_, _, skipped := countTemplateActions(resolved)
	if skipped > 0 {
		return fmt.Errorf("%d assignment(s) skipped during template copy — see stderr for per-assignment reasons", skipped)
	}
	if grantFailures > 0 {
		return fmt.Errorf("%d private template(s) could not be granted to the classroom team — students can't `gh student accept` them until fixed (see stderr)", grantFailures)
	}
	return nil
}

// buildMigratedEntries materializes the AssignmentEntry slice for the commit. A
// commit-time mapping failure (unreachable in normal operation) is recorded as
// a Skipped action so post-commit counts + exit code stay accurate.
func buildMigratedEntries(errOut io.Writer, plan migrationPlan, resolved []resolvedTemplate) []assignment.AssignmentEntry {
	out := make([]assignment.AssignmentEntry, 0, len(resolved))
	for i := range resolved {
		if resolved[i].Action == templateActionSkipped {
			continue
		}
		entry, err := assignmentToEntry(resolved[i].Assignment, plan.Classroom.ID, resolved[i].Template, plan.MigratedAt)
		if err != nil {
			_, _ = fmt.Fprintf(errOut, "Skipping %q at commit time: %v\n", resolved[i].Assignment.Slug, err)
			resolved[i].Action = templateActionSkipped
			resolved[i].SkipReason = "commit-time mapping failed: " + err.Error()
			continue
		}
		out = append(out, entry)
	}
	return out
}

// printMigrationSummary writes the parseable post-commit result to stdout (one
// anchor line + per-file deltas) and follow-up advice to stderr. Counts come
// from the committed entries.
func printMigrationSummary(out, errOut io.Writer, plan migrationPlan, resolved []resolvedTemplate, entries []assignment.AssignmentEntry, commitSHA, branch string) {
	generated, reused, skipped := countTemplateActions(resolved)
	indiv, group := countEntriesByMode(entries)
	short := commitSHA
	if len(short) > 8 {
		short = short[:8]
	}

	_, _ = fmt.Fprintf(out, "%s/%s/%s: migrated from classroom %d (commit %s; %d generated, %d reused, %d skipped)\n",
		plan.TargetOrg, configrepo.ConfigRepoName, plan.ShortName, plan.Classroom.ID, short, generated, reused, skipped)

	_, _ = fmt.Fprintf(out, "  classroom.json     %q (migrated_from: github_classroom/%d)\n",
		plan.Classroom.Name, plan.Classroom.ID)
	_, _ = fmt.Fprintf(out, "  assignments.json   %d entries (%d individual, %d group)\n",
		len(entries), indiv, group)
	_, _ = fmt.Fprintln(out, "  roster.csv         empty (not migrated)")
	_, _ = fmt.Fprintln(out, "  scores.json        empty (not migrated)")

	_, _ = fmt.Fprintf(errOut, "View at https://github.com/%s/%s/tree/%s/%s\n",
		plan.TargetOrg, configrepo.ConfigRepoName, branch, plan.ShortName)
	_, _ = fmt.Fprintln(errOut, "Next:")
	_, _ = fmt.Fprintf(errOut, "  - Add students: gh teacher roster add %s %s <username>\n",
		plan.TargetOrg, plan.ShortName)
	_, _ = fmt.Fprintf(errOut, "  - Author grading code: drop autograder.py under %s/autograders/<slug>/,\n",
		plan.ShortName)
	_, _ = fmt.Fprintf(errOut, "    or set a classroom default: gh teacher autograder set-default %s %s\n",
		plan.TargetOrg, plan.ShortName)
}

// printMigrationPlan writes the plan to stdout in source-API order
// (deterministic so callers can pipe it).
func printMigrationPlan(out io.Writer, plan migrationPlan) error {
	indiv, group, other := plan.countsByMode()
	noun := "assignment"
	if len(plan.Assignments) != 1 {
		noun = "assignments"
	}

	_, _ = fmt.Fprintf(out, "%s/%s/%s: planned migration from classroom %d (%d %s)\n",
		plan.TargetOrg, configrepo.ConfigRepoName, plan.ShortName, plan.Classroom.ID, len(plan.Assignments), noun)
	_, _ = fmt.Fprintf(out, "  source:        %s (org: %s)\n",
		plan.Classroom.Name, plan.Classroom.Organization.Login)
	if plan.Classroom.Archived {
		_, _ = fmt.Fprintf(out, "  archived:      true\n")
	}
	_, _ = fmt.Fprintf(out, "  short_name:    %s\n", plan.ShortName)
	if plan.Term != "" {
		_, _ = fmt.Fprintf(out, "  term:          %s\n", plan.Term)
	}
	_, _ = fmt.Fprintf(out, "  modes:         %d individual, %d group", indiv, group)
	if other > 0 {
		_, _ = fmt.Fprintf(out, ", %d unknown", other)
	}
	_, _ = fmt.Fprintln(out)

	if len(plan.Assignments) == 0 {
		_, _ = fmt.Fprintln(out, "  assignments:   (none)")
	} else {
		_, _ = fmt.Fprintln(out, "  assignments:")
		for _, a := range plan.Assignments {
			starter := "no starter_code_repository — would be skipped"
			if a.StarterCodeRepo != nil {
				privacy := "public"
				if a.StarterCodeRepo.Private {
					privacy = "private"
				}
				starter = fmt.Sprintf("%s @ %s (%s)", a.StarterCodeRepo.FullName, a.StarterCodeRepo.DefaultBranch, privacy)
			}
			line := fmt.Sprintf("    - %-32s mode=%s  starter=%s", a.Slug, a.Type, starter)
			if a.Deadline != nil && *a.Deadline != "" {
				line += "  deadline=" + *a.Deadline
			}
			_, _ = fmt.Fprintln(out, line)
		}
	}
	return nil
}
