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
