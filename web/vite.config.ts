import { defineConfig } from "vitest/config"
import type { Plugin } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import svgr from "vite-plugin-svgr"
import path from "node:path"
import { execSync } from "node:child_process"
import { createRequire } from "node:module"

// Release identity, resolved once at build time and inlined as compile-time
// constants (see src/vite-env.d.ts). Version is the single source of truth in
// package.json; a `web-v*` release tag (VITE_APP_VERSION, set by web-deploy.yaml)
// overrides it so a tagged production build reports its exact release. Commit +
// date come from CI env when present, else git, so local builds still stamp.
function resolveReleaseInfo() {
  const require = createRequire(import.meta.url)
  const pkg = require("./package.json") as { version: string }
  // A `web-v*` release tag arrives as the full ref name (web-v1.0.0); strip the
  // prefix so the app reports a bare semver. Empty/unset falls back to
  // package.json, the source of truth for untagged (main push / local) builds.
  const tagVersion = (process.env.VITE_APP_VERSION || "").replace(/^web-v/, "")
  const version = tagVersion || pkg.version

  const git = (args: string) => {
    try {
      return execSync(`git ${args}`, {
        stdio: ["ignore", "pipe", "ignore"],
        // Cap a hung git (e.g. a stuck credential/index lock) so a build can't
        // hang on version stamping; a timeout throws and falls through to the
        // "unknown" fallback below.
        timeout: 5000,
      })
        .toString()
        .trim()
    } catch {
      return ""
    }
  }
  const commit =
    process.env.VITE_APP_COMMIT || git("rev-parse --short=12 HEAD") || "unknown"
  const buildDate = process.env.VITE_APP_BUILD_DATE || new Date().toISOString()

  return { version, commit, buildDate }
}

const release = resolveReleaseInfo()

// Publishes the release identity as a fetchable /version.json alongside the
// compile-time defines below. GitHub Pages can't set Cache-Control, so a
// long-lived tab could run a stale build forever; it polls this unhashed,
// short-cached file and compares the deployed commit against its inlined
// __APP_COMMIT__ (see src/hooks/useVersionCheck.ts). generateBundle covers
// `vite build`; configureServer serves the same payload in dev so the check
// has an endpoint instead of a 404.
function versionJsonPlugin(): Plugin {
  const body = JSON.stringify(release, null, 2)
  return {
    name: "classroom50:version-json",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: body })
    },
    configureServer(server) {
      server.middlewares.use("/version.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json")
        res.end(body)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(release.version),
    __APP_COMMIT__: JSON.stringify(release.commit),
    __APP_BUILD_DATE__: JSON.stringify(release.buildDate),
  },
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    svgr(),
    tailwindcss(),
    babel({ presets: [reactCompilerPreset()] }),
    versionJsonPlugin(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    fs: {
      // src/skeleton/skeleton.ts imports the skeleton from
      // cli/gh-teacher/skeleton (outside web/), so the dev server must read the
      // monorepo root. `vite build` inlines the files regardless.
      allow: [path.resolve(__dirname, "..")],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
})
