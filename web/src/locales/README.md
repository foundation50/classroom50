# Language packs

The web app ships with English built in ([`en.json`](./en.json)) and lets anyone
add more languages at runtime — no rebuild, no PR. A "language pack" is a JSON
file with the same shape as `en.json`, translated into another language. You
install it from the account menu (avatar → Language), either by uploading the
file or pasting a URL to it.

## Creating a pack

1. Copy [`en.json`](./en.json) — it is the single source of truth for every
   translatable string.
2. Translate the **values** into your target language. Leave the **keys** and
   the JSON structure exactly as they are.
3. Save it as `<code>.json` (e.g. `de.json`, `pt-BR.json`).

An LLM does this well. Use the ready-made prompt in
[`TRANSLATION_PROMPT.md`](./TRANSLATION_PROMPT.md) — it is language-agnostic and
encodes the rules that matter here (keys/placeholders preserved, concatenated
`_prefix`/`_suffix` fragments reassembled for the target word order, GitHub UI
labels kept findable, consistent terminology).

### Example: translating with an agent

Point the agent at the prompt and name a target language, e.g.:

> Follow @src/locales/TRANSLATION_PROMPT.md and produce a Korean translation.

The agent should then:

1. Read [`TRANSLATION_PROMPT.md`](./TRANSLATION_PROMPT.md) and translate
   [`en.json`](./en.json) into the target language.
2. Save the result as `<code>.json` in this folder (e.g. `ko.json`).
3. Verify integrity against the base before finishing:

   ```bash
   cd src/locales
   python verify_locale.py ko.json
   ```

   Do not ship a pack that does not print `RESULT: PASS`. The checker
   ([`verify_locale.py`](./verify_locale.py)) flags any dropped/added/renamed
   key, non-string value, or placeholder mismatch — the failure modes that
   silently break a pack. It mirrors the installer's own validation, so a
   passing pack also installs cleanly.

### Automated packs (CI)

The target languages in [`targets.json`](./targets.json) are also produced
automatically: a GitHub Actions workflow
([`.github/workflows/translate-locales.yaml`](../../../.github/workflows/translate-locales.yaml))
patches each target from `en.json` with AWS Bedrock whenever `en.json` changes,
then opens a single pull request on a separate public translations repo carrying
every language that patched cleanly, for a human to review and merge. Batching
into one PR means one merge and one GitHub Pages deploy rather than one per
language.

It is a **patch**, not a regenerate. Because every pack shares `en.json`'s exact
key structure, a structural diff of `en.json` maps 1:1 onto every language — the
same dotted keys are added/modified/removed in each. So per language the CI:

- diffs **our `en.json`** against that language's published **baseline marker**
  (`markers/<code>.json` in the translations repo — a verbatim copy of the
  `en.json` the pack was last built against) into `{changed keys, removed keys}`
  ([`scripts/locale_diff.py`](../../../scripts/locale_diff.py)),
- downloads the published `<code>.json`,
- **translates only the changed/added keys** and writes them in, deletes removed
  keys, and **leaves every other key exactly as published.**

The marker lives in the translations repo and _holds the state we diff against_,
so the effective diff is always "everything unpublished since this language last
published" — independent of run cadence, re-runs, or how many `en.json` commits
happened in between. The publish PR bumps each produced language's
`markers/<code>.json` to the current `en.json` in the same commit as its pack,
so the marker advances only when the pack does. A language that fails a run
keeps its old marker and is caught up on the next run — no gap. (A nice
byproduct: the PR shows the English diff in `markers/<code>.json` right next to
the pack diff.)

The generator
([`scripts/translate_locales.py`](../../../scripts/translate_locales.py)) uses
this same `TRANSLATION_PROMPT.md` as its system prompt and gates output with
`verify_locale.py`, so machine and hand-made packs follow one contract. A
language with no marker yet, or a manual `workflow_dispatch`, falls back to a
full first-time translation. If a patched pack ever fails the structural gate
(e.g. a pre-existing defect on a key this run didn't touch), CI automatically
retries that language with a full retranslation — which re-emits every key — and
only fails the language if it still doesn't pass.

**Retiring a language.** Removing a code from [`targets.json`](./targets.json)
only stops CI from _updating_ it — the workflow never deletes files from the
translations repo, so the language's `<code>.json` and `markers/<code>.json`
stay published (and still offered to users via the registry's `index.json`)
until you delete them there by hand. To fully retire a language, remove it from
`targets.json` here **and** delete both files from the translations repo.

### Community contributions are durable

Because CI only ever touches the keys whose English changed, **hand edits to a
published pack survive verbatim.** Anyone can open a PR against the translations
repo to fix a wording, adjust a fragment, or add a plural variant; once merged,
CI will never overwrite that key on later runs — it only re-touches a key if its
**English source** later changes (a reworded `en.json` value), and only adds
keys that are genuinely new. This makes the translations repo the place to
contribute improvements, not a throwaway machine output.

### Rules the installer enforces

Packs are validated on install and re-validated every time they are loaded
from storage. A pack is rejected when it breaks any of these:

- **Valid JSON object.** Nested objects are fine (they are flattened to dotted
  keys internally); every leaf value must be a **string** — no arrays, numbers,
  booleans, or null.
- **Language code** must be a plausible BCP-47 tag: a 2-3 letter language
  subtag, optionally followed by `-` subtags (`de`, `ja`, `pt-BR`,
  `zh-Hans-CN`). It is detected from the file name / URL (e.g. `pt-BR.json` ->
  `pt-BR`); you are only prompted to type it when it can't be detected.
- **Size cap:** 512 KB per pack file.
- **Key cap:** 5,000 keys per pack.
- `en` itself can't be replaced — it is the built-in base.

### Placeholders and plurals

- Values may contain `{{name}}`-style placeholders (about 190 keys use them).
  Keep them **verbatim** — the app substitutes runtime data (usernames, repo
  names, counts) into them. A translated value that drops or renames a
  placeholder will render incorrectly.
- Plural forms use i18next's `_one` / `_other` key suffixes (e.g.
  `students.count_one`, `students.count_other`). Languages with different
  plural rules can use the other i18next plural suffixes (`_zero`, `_few`,
  `_many`, ...) for the same base key.
- GitHub-sourced data (usernames, org/repo/classroom names) is interpolated,
  never translated.

### Partial packs are fine

A pack does not need to translate every key. Missing keys fall back to
English at runtime, and the language switcher shows a coverage badge (e.g.
"78%") next to partially translated packs. This means a pack made for an older
version of the app keeps working after new strings are added — the new strings
just show in English until the pack is updated.

## Installing

Account menu (avatar in the sidebar) → **Language**:

- **Upload:** pick the `.json` file — the language code is detected from the
  file name (enter it manually only if detection fails). A preview shows the
  detected code, translation coverage, and sample strings; the pack is applied
  only after you confirm.
- **URL:** paste a link to the raw JSON (e.g. a public
  `raw.githubusercontent.com` link) and press Fetch — the code is detected from
  the URL. Only `http(s)` URLs are accepted, the response is size-capped while
  downloading, and the host must allow CORS — if the fetch fails, download the
  file and use the upload path instead. As with upload, you confirm from the
  preview before it is applied.

Installed packs persist in the browser's `localStorage` and survive reloads.
Multiple packs can be installed side by side and switched between; removing a
pack that is currently active falls back to English. Language changes and
pack installs/removals sync across open tabs.

### Storage format (for tools)

Programmatic producers can target the same storage the UI uses (all under the
app's origin):

- `classroom50:custom-locales` — a JSON map of
  `{ [code]: { code, bundle } }`, where `bundle` is the **flattened** pack
  (dotted keys, string values).
- `classroom50:lang` — the active language code.

Values written here are untrusted input: they are re-validated on every load,
and anything failing validation is dropped (falling back to English). The
validation/installation API lives in
[`../i18n/customLocale.ts`](../i18n/customLocale.ts) (`parseBundle`,
`installPack`, `missingKeys`, `coverage`).

## Known limitations

- A handful of strings asserted by unit tests in the `orgMembers` logic files
  remain English.
