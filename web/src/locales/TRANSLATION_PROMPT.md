# Translation prompt

Use this prompt to translate the base locale (`en.json`) into a new language
pack with an LLM. It is written to be applicable to **any** target language.
After translating, always run the integrity check in
[`verify_locale.py`](./verify_locale.py) before shipping the pack.

Replace `<CODE>` with the target BCP-47 locale code (e.g. `es`, `hi`, `zh-CN`).

---

You are translating the UI language pack for **Classroom 50**, a GitHub-based
assignment-management and autograding platform (a self-hosted GitHub Classroom).
Translate the JSON **values** in `en.json` into the target language (locale code
`<CODE>`).

## Audience & register

- Two audiences: **instructors/TAs** (comfortable with GitHub jargon) and
  **students**. Use a clear, professional, friendly register.
- **Audience-appropriate vocabulary.** The product is used across a wide range of
  educational settings, from K-12 through higher education. Prefer **neutral,
  widely-applicable** terms for words like "student," "instructor,"
  "class/classroom," and "term" — wording that reads naturally to teachers and
  learners at any level, rather than terms that lock the text to one specific
  level of schooling. If your language forces a choice, pick the most inclusive
  general-purpose option.
- **Follow the target language's own conventions.** Every language has its own
  norms for punctuation, quotation marks, ellipsis, spacing (e.g. around Latin
  words/numbers), word order, honorific/politeness level, measure words, and
  pluralization. Apply the conventions that a native reader expects — do not carry
  over English punctuation, spacing, or sentence structure just because the source
  uses it.

## Hard rules (violating these breaks the app)

1. **Never drop, add, rename, or reorder keys.** Keep every key and the full
   nesting structure exactly as in the source. The output must contain the **same
   set of keys** as the input — no omissions, even for values you leave in English.
   Translate only the string values. Return valid JSON with the same shape; every
   leaf value must be a string.
2. **Never drop, add, rename, or reorder placeholders.** Keep every
   `{{placeholder}}` **verbatim** — identical name, identical count per value. They
   are substituted at runtime (usernames, org/repo/classroom names, counts, dates).
   Never translate or alter text inside `{{ }}`.
3. **Do not translate** GitHub-sourced identifiers or code: usernames,
   org/repo/classroom names, slugs, `classroom50`, branch names like `main`, tokens
   like `github_pat_...`, `ubuntu-latest`, language/tool names, `pytest`,
   `stdin`/`stdout`, `re.search`, file names, CLI commands, and anything that looks
   like code.
4. **Plurals:** keys ending in `_one` / `_other` are i18next plural forms. If your
   language has no plural distinction, give both the same translation. If your
   language needs other forms (`_zero`, `_few`, `_many`, …), add those sibling keys
   for the same base key — but still never remove the existing ones.

## Concatenated sentence fragments — MOST IMPORTANT

Some sentences are **split across sibling keys** and joined at runtime with an
interpolated value **in between**. Keys ending in `_prefix`, `_from`, `_middle`,
`_suffix`, `_emphasis`, `_link`, and numbered parts (`_1`, `_2`, `_3`, …) are
assembled **in order**, with a value (org name, `{{classroom}}`, `classroom50`, a
link, etc.) inserted at each join.

For each such group:

1. **Reconstruct the full English sentence**, using a marker for each injected
   value, e.g. `prefix` + `[VALUE]` + `from` + `[VALUE]` + `suffix`.
2. **Translate the whole sentence naturally** in the target language.
3. **Split it back** into the same fragments so that, when rejoined with the value
   at each boundary, it reads grammatically. The value's position is **fixed by the
   code** and cannot be moved — choose fragment wording that works with the value
   where it lands.
4. **Do not repeat a word/verb** across the prefix and suffix (a common error), and
   don't leave a fragment that only parses in English word order.
5. If your language would naturally reorder the injected value, adapt the
   surrounding fragments (particles, prepositions, measure words) so the fixed
   position still reads correctly. If a clean split is impossible, put the whole
   phrase in one fragment and leave the other fragment as an empty string (`""`)
   rather than emit a broken sentence.

Read each reassembled group aloud with a sample value substituted to confirm it is
grammatical.

## GitHub UI label consistency

Some strings (e.g. under `orgSettings`) reference **buttons/fields the user must
click on GitHub**. Render these to **match GitHub's own official UI in the target
language** so users can locate the control; if GitHub does not localize a given
label, keep it in English. Be consistent — one policy per label, applied
everywhere.

## Terminology consistency

Pick one translation per recurring domain term (assignment, submission, classroom
vs class, roster, onboarding, autograder, runner, template, repository, service
token, organization, unenroll, regrade, collect, …) and use it consistently across
the entire file.

## Output

Return **only** the translated JSON — no explanations, no markdown fences.
Translate **every** value; if something is genuinely untranslatable, keep the
English rather than omit the key.

---

## Verify integrity after translation (required)

After producing `<CODE>.json`, run the integrity check from the `src/locales`
folder:

```bash
python verify_locale.py <CODE>.json
```

It compares the pack against `en.json` and fails loudly on any missing/extra key,
non-string value, or placeholder mismatch. Do not ship a pack that does not
`PASS`. This mirrors the app's own `missingKeys` / `coverage` validation in
[`../i18n/customLocale.ts`](../i18n/customLocale.ts), so a passing pack also
installs cleanly.
