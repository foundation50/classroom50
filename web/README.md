# Classroom 50 GUI Alpha

The frontend for Fifty Foundation's teacher-student GitHub Pages-based assignment management and grading platform.

Built with React + TypeScript + Vite (React Compiler enabled), TanStack Router/Query, Tailwind, and daisyUI.

## Local development

Requires Node/npm.

1. `npm i`
2. Create a `.env.local` file in the repo root (gitignored) with your GitHub OAuth app client ID:

   ```bash
   VITE_GITHUB_CLIENT_ID=<your-oauth-app-client-id>
   ```

3. `npm run dev` and open http://localhost:5173

To skip the sign-in screen during local development, set a classic GitHub PAT in
`.env.local` as `VITE_GITHUB_PAT` — the dev server validates it (same required
scopes as the manual paste flow) and auto-signs-in on load. `vite.config.ts`
hard-blanks this value for any non-development build, so it can never be inlined
into a deployed bundle. It also never overrides an existing signed-in session.
Still, don't set it for a production build you ship — a `VITE_*` value is inlined
verbatim into the bundle, and that build-time strip is the only guard.

### GitHub OAuth app

Sign-in requires a [GitHub OAuth app](https://github.com/settings/developers):

- **Web flow**: set the app's authorization callback URL to `http://localhost:5173/login` for local development (`https://classroom50.org/login` in production).
- **Device flow**: check "Enable Device Flow" in the OAuth app settings.

Browser-blocked GitHub calls (the OAuth token exchange, which holds the client secret, and repo archive downloads, which codeload serves without CORS) go through a GitHub proxy. It defaults to the Fifty Foundation Cloudflare Worker; override with `VITE_GITHUB_PROXY_BASE` in `.env.local` if you run your own.

If no `VITE_GITHUB_CLIENT_ID` is set, the app falls back to a client ID previously saved in the browser's localStorage (from older builds that had a client ID input on the login screen).

## Languages

English is built in; other languages are user-installable at runtime as
sideloadable JSON language packs (account menu → Language). See
[src/locales/README.md](src/locales/README.md) for the pack format, validation
rules, and the translate-`en.json`-with-an-LLM workflow.

## Deployment

Web-affecting pushes to `main` deploy to
[preview.classroom50.org](https://preview.classroom50.org) via
`.github/workflows/web-deploy-preview.yaml`. That workflow builds and tests the
web app, publishes `web/dist` to the `build` branch of
`foundation50/classroom50-web-preview`, then dispatches that repo's GitHub Pages
workflow.

Production deploys to [classroom50.org](https://classroom50.org) only when the
release-please Release PR is merged and a `web-v*` release is created. Manual
production redeploys are available through `.github/workflows/web-deploy.yaml`
as an escape hatch.

The GitHub OAuth client ID comes from the `VITE_GITHUB_CLIENT_ID` repository
variable (Settings → Secrets and variables → Actions → Variables) — it is a
public identifier, not a secret. If preview reuses the same OAuth app, include
`https://preview.classroom50.org/login` in its allowed callback URLs.

### Usage analytics

Analytics vendors are wired in two places, and only those two:

- **Build:** `web/vite/analytics.ts` lists each vendor (Google Tag Manager,
  Cloudflare Web Analytics), the `VITE_*` variable that enables it, and the
  snippet to inject into `index.html`, behind one shared consent runtime that
  starts a vendor only once its category is granted (see Consent below) and
  never while the browser sends Global Privacy Control or Do Not Track. No
  variable, no script; `npm run dev` injects the runtime alone so the prompt
  can be worked on without a vendor. Tests in `web/vite/analytics.test.ts`
  execute the generated snippets against fakes.
- **Deploy:** `.github/actions/web-analytics-env` maps repository variables to
  those `VITE_*` variables for the `production` or `preview` environment, and
  prints which vendors ran in the job summary. Each deploy workflow calls it
  once, right before `npm run build`.

Adding a vendor is one provider entry in `analytics.ts` and one row in the
action. Removing one is deleting them again, or unsetting its variables.

| Vendor                   | Production variable     | Preview variable                | Value                                                                                 |
| ------------------------ | ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| Google Tag Manager       | `VITE_GTM_CONTAINER_ID` | `VITE_GTM_CONTAINER_ID_PREVIEW` | The container ID, for example `GTM-ABC123`, from a separate container per environment |
| Cloudflare Web Analytics | `VITE_CF_BEACON_TOKEN`  | `VITE_CF_BEACON_TOKEN_PREVIEW`  | The site token, from a separate Cloudflare site per environment                       |

All values are public identifiers that ship in the HTML, not secrets. For a
local build, set the `VITE_*` variables in `.env.local`; `npm run dev` and
`npm run build` both pick them up. Cloudflare rejects beacons from `localhost`,
so local Cloudflare tracking needs a hostname you own pointed at `127.0.0.1`,
registered as its own Cloudflare site (Cloudflare matches hostnames by suffix,
so never reuse the production token for it).

#### Consent

Nothing optional runs until the visitor accepts. Each vendor declares a consent
category, one per vendor (`cloudflare`, `google`), and the `functional`
category covers what the app stores to work (always on, no control). The
prompt preselects every optional category; Accept saves what is selected and
Decline turns everything optional off. Nothing starts while the browser sends
Global Privacy Control or Do Not Track. The record lives in localStorage as
`classroom50:consent` (`{ v, at, cloudflare, google }`, see
`src/types/consent.ts`); absent means undecided, and `CONSENT_VERSION` lets a
future policy change re-ask everyone. The pre-consent opt-out key
(`classroom50:analytics` = `off`) is honored as a denial so earlier visitors
aren't asked again.

`ConsentProvider` (`src/context/consent/`) owns the state. `components/consent/`
holds the prompt (a full-width bottom `Modal` with `backdrop="focus"`, which
dims the page to about half and blurs it), the category list in a compact
checkbox shape for the prompt and a toggle-row shape for pages, and the form
that Settings and `/privacy` embed with start-aligned actions and a **Reset and
ask again** button. Both surfaces read the same record, so they always agree.
`lib/analyticsRuntime.ts` bridges to the injected runtime so accepting starts
vendors without a reload, and turning Google off pushes a Consent Mode `denied`
update and clears its cookies. Adding a vendor means a provider entry with its
own category in `OPTIONAL_CONSENT_CATEGORIES`, plus copy under
`consent.categories.<id>`.

#### Google Tag Manager container setup

The repository controls when the container loads and sets Consent Mode
defaults (analytics storage granted, every other storage type denied). What the
container does is configured in Google Tag Manager, and the privacy notice's
claims depend on this configuration. When you set up a container:

1. Add a Google Analytics 4 tag with the measurement ID of a property created
   for that environment.
2. In the tag, override `page_location` with a variable that strips the query
   string. The app's URLs carry OAuth codes, invite link keys, and roster
   searches, and Google Analytics records the full URL by default.
3. In the Google Analytics property, under enhanced measurement, turn off
   **Site search**. Its default parameter list includes `q`, which the roster
   page uses for a username or email search.
4. In the property, turn off Google Signals, set data retention to 14 months,
   and turn on **Redact email** under data collection settings.
5. Don't add tags beyond Google Analytics. The privacy notice describes
   analytics only, and Consent Mode denies every non-analytics storage type,
   so other tag types would not work anyway.

Container publishing is a security control, not only a configuration step.
Anything published in the container runs as script on classroom50.org, on the
same origin where the visitor's GitHub token lives in local storage, and the
app ships no Content Security Policy (it must fetch from any organization's
custom GitHub Pages domain, which a policy cannot allowlist in advance). So:

- Keep the container's Publish permission to the smallest group of Google
  accounts, all with 2-step verification, and use a separate Edit role for
  everyone else.
- Turn on container approval (workspace changes need a second person to
  publish) if the account plan offers it, and review the container's version
  history when you review a release.
- Treat step 2 above as part of the privacy notice: the notice says query
  strings are not recorded because this override exists. Check it after any
  container change.

The privacy notice tells visitors Google Analytics collects the pages they
view and how long they stay, the referring site, country, browser, device, and
language, sets a 2-year cookie, and keeps data for up to 14 months. Those are
GA4's defaults with the settings above; if you change them, change the notice
(`privacy.*` and `consent.categories.google.*` in `src/locales/en.json` and the
wiki's Privacy and FERPA section) in the same change.

Google's noscript `<iframe>` from the install instructions is intentionally not
injected: the app needs JavaScript anyway, and a noscript beacon could not
honor consent.

The processor agreement that governs Google Analytics is Google's data
processing terms for its measurement products
(business.safety.google/adsprocessorterms). The privacy notice deliberately
links Google's Privacy Policy and the required "How Google uses information"
page instead, because the notice describes analytics only and that document's
title would suggest otherwise. Keep a copy of the accepted terms with the
project's records.
