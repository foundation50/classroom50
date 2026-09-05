# Accessibility conformance (VPAT / ACR)

This directory holds the **human-owned** input to Classroom 50's WCAG 2.2 AA
conformance report. Everything else is derived from it — there is a single
source of truth, rendered into several views.

## The single source

| Piece                  | Where                                        | Role                                                                                                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manual verdicts**    | `accessibility/vpatVerdicts.json` (this dir) | The only hand-edited file: per-criterion human verdicts (`status`, `evidence: "manual"`, `assessed` date, `remark`).                                                                                                                                                         |
| **Base model**         | `src/util/a11y/vpatModel.ts`                 | Every WCAG 2.2 A/AA criterion (plus 1.4.6 and 4.1.1) + the overlay logic (`applyVerdicts`). Contrast rows are re-derived from the live audit; automated rows are set by tooling; criteria the product's design rules out are `notApplicable` with an `architectural` reason. |
| **Assessor guidance**  | `src/util/a11y/assessmentGuidance.ts`        | The "how to test each SC" prose the `/assess` tool shows.                                                                                                                                                                                                                    |
| **Report renderer**    | `src/util/a11y/vpatReport.ts`                | Renders the ACR (VPAT 2.5Rev, WCAG edition) and the canonical JSON from the model.                                                                                                                                                                                           |
| **Automated bindings** | `src/util/a11y/vpatAutomated.ts`             | Ties each `automated` verdict to the hermetic check that establishes it.                                                                                                                                                                                                     |

All the a11y model/report code lives under `src/util/a11y/` (a pure leaf layer —
no app imports); the report generators live under `scripts/a11y/`. The guards
(`src/util/a11y/vpatGuard.test.ts`, `vpatAutomated.test.ts`) fail CI on any
overclaim — e.g. a `supports` with no evidence — so the rendered report can
never drift from this file.

Do **not** hand-edit the generated artifacts (`VPAT.md`,
`ACCESSIBILITY-REPORT.md`, `vpat-report.json`, `contrast-audit.json`,
`a11y-inventory.json`) — they are gitignored renderings. Edit `vpatVerdicts.json`
(via the tool below) instead.

## Verdict shape

```json
{
  "2.4.1": {
    "status": "partially", // supports | partially | doesNotSupport
    "evidence": "manual", // always "manual" for this file
    "assessed": "2026-08-05", // ISO date; rendered in the report's Date column
    "remark": "…what was tested + the outcome (no date prefix)…"
  }
}
```

A verdict may only land on a criterion that is still `notEvaluated` in the base
model; targeting an automated/contrast/architectural row throws (the tooling
refuses to overwrite a machine-established verdict). Keep the date out of the
remark — it now has its own `assessed` field and report column.

## Guided reassessment — setup

The `/assess` route is a **dev-only** interactive tool: it lists each
manually-owned criterion with its assessor guidance, lets you record a verdict,
and writes it back to `vpatVerdicts.json` through a serve-only endpoint. It
redirects away and its write endpoint does not exist in a production build.

1. **Start the dev server** from `web/`:

   ```bash
   npm run dev
   ```

2. **Sign in.** The app needs an authenticated GitHub session to reach the
   teacher flows you'll be assessing. Either sign in on the login screen, or set
   a dev auto-login token in `web/.env.local`:

   ```
   VITE_GITHUB_PAT=ghp_your_classic_pat_with_repo_read_org_scopes
   ```

   The PAT is a dev convenience only — the build-time strip in `vite.config.ts`
   keeps it out of any production bundle. To review the **login screen itself**
   (e.g. for 3.3.8 Accessible Authentication), comment the PAT out so auto-login
   doesn't bypass it.

3. **Open the tool** at `http://localhost:5173/assess`. Each outstanding
   criterion shows its guidance (what "Supports" means, and the keyboard /
   screen-reader steps to check). Navigate the app to the relevant screen, test
   it, then record: pick a verdict (Supports / Partially Supports / Does Not
   Support) and write a remark describing **what you tested and the outcome**.
   Saving stamps today's date into `assessed` automatically and writes
   `vpatVerdicts.json`.

4. **Reopen** a recorded verdict to revise it; the tool re-derives the report
   live after each save.

### Honesty discipline

- Record `supports` only for what you actually verified. Leave a criterion
  `notEvaluated` (don't record) rather than overclaim.
- A remark should name the flow(s) tested and the method (keyboard pass,
  accessibility-tree inspection, screen-reader listen), and call out any residual
  gap that keeps it `partially`.
- Automated and contrast criteria are **not** editable here — they're
  established by the CI-guarded checks, shown read-only for context.

## Regenerate the reports

From `web/` (outputs are gitignored; CI uploads them as artifacts and the Vite
build emits them into `dist/`, served at `/VPAT.md`,
`/ACCESSIBILITY-REPORT.md`, `/vpat-report.json`, `/CONTRAST-AUDIT.md`,
`/contrast-audit.json`):

```bash
npm run audit:vpat            # VPAT.md (WCAG) + ACCESSIBILITY-REPORT.md (combined) + vpat-report.json
npm run audit:contrast        # CONTRAST-AUDIT.md + contrast-audit.json
npm run audit:a11y            # the automated a11y checks (axe + structural + bindings)
npm run audit:a11y:inventory  # a11y-inventory.json (what each verdict is backed by)
```

The live, no-auth report is always at `/accessibility` in the running app.

## Report format

The ACR follows **VPAT® 2.5Rev** (the ITI industry-standard template), WCAG
edition. The header carries every field the template's "Essential Requirements
for Authors" mandate: the "[Company] Accessibility Conformance Report" title,
template version, Name of Product/Version, Report Date, Product Description,
Contact Information, Notes, Evaluation Methods Used, the Applicable
Standards/Guidelines table (WCAG 2.0, 2.1, 2.2 at Level A and AA), and the ITI
term definitions verbatim. The version is the `web-v*` release tag when the
build has one (`release.tagVersion` in `vite.config.ts`, `VITE_APP_VERSION` for
the generator); an untagged build names no version rather than borrowing the
last release's.

The tables use columns **Criteria · Level · Conformance Level · Assessed ·
Remarks and Explanations**, grouped by WCAG principle (the template allows
combining its per-level tables; numerical order is preserved within each). The
`Assessed` column carries each verdict's date so remarks stay focused on the
finding. Criteria added after WCAG 2.0 are marked "(2.1 and 2.2)" or "(2.2
only)" as in the template, via `since` on the model.

The report lists **every** WCAG 2.2 Level A and AA criterion (55), so a
reviewer can file it against WCAG 2.0, 2.1, or 2.2. Nothing is omitted: a
criterion the product cannot trigger (captions with no media, motion actuation
with no sensors) is marked _Not Applicable_ with the reason in its remark, and
4.1.1 Parsing is answered _Supports_ for 2.0/2.1 as the template instructs.
`vpatGuard.test.ts` pins the count so the list cannot silently shrink.

**Not Evaluated on A/AA rows is a declared deviation.** ITI reserves that term
for Level AAA. Until the manual assessment covers every A/AA criterion, the
renderer adds a Notes bullet listing the pending ids as a deviation from the
ITI terms (the template requires deviations to be declared there). Recording
the outstanding verdicts through `/assess` removes the bullet automatically.
