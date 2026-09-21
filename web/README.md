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
  snippet to inject into `index.html`. Every snippet runs inside one shared
  gate that skips it when the browser sends Global Privacy Control or Do Not
  Track, or when the visitor opted out (the `analytics` preference,
  `classroom50:analytics` in localStorage, stored only as `off`). No variable,
  no script. Tests in `web/vite/analytics.test.ts` execute the generated
  snippets against fakes.
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

#### Google Tag Manager container setup

The repository controls when the container loads and sets Consent Mode
defaults (advertising storage denied, analytics storage granted). What the
container does is configured in Google Tag Manager, and the privacy notice
assumes this configuration. When you set up a container:

1. Add a Google Analytics 4 tag with the measurement ID of a property created
   for that environment.
2. In the tag, override `page_location` with a variable that strips the query
   string. The app's URLs carry OAuth codes, invite link keys, and roster
   searches, and Google Analytics records the full URL by default.
3. In the Google Analytics property, turn off Google Signals, set data
   retention to 14 months or less, and turn on **Redact email** under data
   collection settings.
4. Don't add advertising or remarketing tags. The privacy notice says
   advertising is switched off, and Consent Mode denies advertising storage.

Google's noscript `<iframe>` from the install instructions is intentionally not
injected: the app needs JavaScript anyway, and a noscript beacon could not
honor the opt-out.
