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

- Two audiences: **teachers/TAs** (comfortable with GitHub jargon) and
  **students**. Use a clear, professional, friendly register.
- **Audience-appropriate vocabulary.** The product is used across a wide range of
  educational settings, from K-12 through higher education. Prefer **neutral,
  widely-applicable** terms for words like "student," "teacher," "classroom,"
  and "term" — wording that reads naturally to teachers and learners at any
  level, rather than terms that lock the text to one specific level of schooling.
  If your language forces a choice, pick the most inclusive general-purpose
  option.
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
2. **Never drop, add, rename, or alter the text inside placeholders.** Keep every
   `{{placeholder}}` **verbatim** — identical name, identical count per value. They
   are substituted at runtime (usernames, org/repo/classroom names, counts, dates).
   A placeholder may **move** to wherever the target grammar needs it — position
   is free, the token itself is not.
   Never translate or alter text inside `{{ }}`.
3. **Do not translate** GitHub-sourced identifiers or code: usernames,
   org/repo/classroom names, slugs, `classroom50`, branch names like `main`, tokens
   like `github_pat_...`, `ubuntu-latest`, language/tool names, `pytest`,
   `stdin`/`stdout`, `re.search`, file names, CLI commands, and anything that looks
   like code.
4. **Plurals:** keys ending in `_one` / `_other` are i18next plural forms. If your
   language has no plural distinction, give both the same translation. If your
   language needs other forms (`_zero`, `_few`, `_many`, …), you **must** add those
   sibling keys for the same base key — i18next does not fall back to your
   `_other` for a missing category; it renders **English** for those counts
   (e.g. Arabic without `_few` shows English for counts 3–10). Arabic needs all
   of `_zero`/`_one`/`_two`/`_few`/`_many`/`_other`; Hebrew needs
   `_one`/`_two`/`_other`; Russian/Polish/Czech need `_one`/`_few`/`_many`/`_other`.
   Never remove the existing `_one`/`_other` keys.

## Inline markup tags — MOST IMPORTANT

Some values contain **HTML-like markers** alongside `{{placeholders}}`, e.g.:

```json
"emptyBody": "No Feedback PR has been opened for <repo>{{repo}}</repo> yet."
```

These are react-i18next `<Trans>` component tags: the app replaces each tag pair
with a styled element (a link, a monospace repo name, an emphasized word) at
runtime. For each such value:

1. **Keep every tag verbatim** — same tag names, same open/close/self-closing
   form, same count, same nesting. Never translate, rename, drop, or add tags
   (`<repo>` stays `<repo>`, never `<dépôt>`).
2. **Reorder freely.** Like a bare placeholder, a tagged span can move anywhere
   in the sentence — put it wherever the target grammar wants it, together with
   its content.
3. **Translate the content inside a tag** when it is prose (e.g. link text like
   `<link>accept it</link>`), but leave it untouched when it is a
   `{{placeholder}}` or code.
4. Adapt the surrounding words (particles, prepositions, measure words) to the
   tagged span's final position so the sentence reads naturally.

Read each translated value aloud with a sample value substituted for the
placeholder to confirm it is grammatical.

## GitHub UI label consistency

Some strings (e.g. under `orgSettings`) reference **buttons/fields the user must
click on GitHub**. Render these to **match GitHub's own official UI in the target
language** so users can locate the control; if GitHub does not localize a given
label, keep it in English. Be consistent — one policy per label, applied
everywhere.

## Terminology consistency

Pick one translation per recurring domain term (assignment, submission,
classroom, teacher, roster, onboarding, autograder, runner, template,
repository, service token, organization, unenroll, regrade, collect, …) and use
it consistently across the entire file.

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
non-string value, placeholder mismatch, or markup-tag mismatch. Do not ship a
pack that does not `PASS`. This mirrors the app's own `missingKeys` / `coverage` validation in
[`../i18n/customLocale.ts`](../i18n/customLocale.ts), so a passing pack also
installs cleanly.
