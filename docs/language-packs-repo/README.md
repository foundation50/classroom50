# Language-packs repo — Pages publisher (staging copy)

These files belong in the **language-packs repo**
(`foundation50/classroom50-language-packs`), not in `classroom50`. They are
staged here for convenience because that repo isn't checked out in this
workspace.

## What it does

[`.github/workflows/publish-pages.yaml`](.github/workflows/publish-pages.yaml)
publishes the merged `<code>.json` packs on `main` to GitHub Pages, plus an
`index.json` manifest listing the published language codes. This makes the packs
reachable at a public URL while the repo itself stays private (Pages sites are
public regardless of repo visibility).

After deploy, packs are served at:

```
https://foundation50.github.io/classroom50-language-packs/<code>.json
https://foundation50.github.io/classroom50-language-packs/index.json
```

(If a custom domain or user/org Pages site is configured, the base URL differs
accordingly.)

## One-time setup on the language repo

1. Copy this tree into the repo root:

   ```
   .github/workflows/publish-pages.yaml
   ```

2. In the language repo: **Settings → Pages → Build and deployment → Source =
   GitHub Actions**.

3. Merge a language PR (or run the workflow manually via **Actions → Publish
   Pages → Run workflow**). The first push to `main` touching a `*.json` file
   triggers a deploy.

## Notes

- Allow-list publishing: only `<code>.json` packs and the generated
  `index.json` are deployed; anything else in the repo stays unpublished.
- The `index.json` manifest is what the client localization UI should read to
  discover available languages, instead of hardcoding the target list.
