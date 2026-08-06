import { defineConfig } from "vitest/config"
import { loadEnv } from "vite"
import { playwright } from "@vitest/browser-playwright"
import type { Plugin } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import svgr from "vite-plugin-svgr"
import path from "node:path"
import { readFileSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { createRequire } from "node:module"

import {
  renderContrastJson,
  renderContrastReport,
} from "./src/util/a11y/contrastReport"
import {
  renderCombinedReport,
  renderVpatJson,
  renderVpatReport,
} from "./src/util/a11y/vpatReport"
import {
  buildCriteria,
  isValidAssessedDate,
  type ManualVerdict,
  type VerdictOverlay,
} from "./src/util/a11y/vpatModel"
import { ASSESSMENT_GUIDANCE } from "./src/util/a11y/assessmentGuidance"

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
        // Cap a hung git (e.g., a stuck credential/index lock) so a build can't
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

// Publishes the WCAG contrast audit in the built site: contrast-audit.json (the
// source of truth the /accessibility page fetches) and CONTRAST-AUDIT.md (the
// human-readable download, derived from the same data). Both are served in dev
// too, so `npm run dev` shows a live report at /accessibility. Generated from
// src/util/a11y/contrastModel.ts at build time — never committed — so they are always
// current with the shipped palette. The contrast guard tests are the
// enforcement; these files are renderings.
function contrastAuditPlugin(): Plugin {
  const json = renderContrastJson()
  const md = renderContrastReport()
  const assets: { fileName: string; source: string; type: string }[] = [
    { fileName: "contrast-audit.json", source: json, type: "application/json" },
    {
      fileName: "CONTRAST-AUDIT.md",
      source: md,
      type: "text/markdown; charset=utf-8",
    },
  ]
  return {
    name: "classroom50:contrast-audit",
    generateBundle() {
      for (const a of assets) {
        this.emitFile({ type: "asset", fileName: a.fileName, source: a.source })
      }
    },
    configureServer(server) {
      for (const a of assets) {
        server.middlewares.use(`/${a.fileName}`, (_req, res) => {
          res.setHeader("Content-Type", a.type)
          res.end(a.source)
        })
      }
    },
  }
}

// Publishes the WCAG 2.2 VPAT / ACR in the built site: vpat-report.json (the
// source of truth the /accessibility page fetches) plus VPAT.md (WCAG edition)
// and VPAT-INT.md (INT edition: Section 508 + EN 301 549 + WCAG 2.2), the
// human-readable downloads, and ACCESSIBILITY-REPORT.md (both editions + the
// contrast audit in one file). All derive from src/util/a11y/vpatModel.ts at
// build time — never committed — so they stay current with the shipped app;
// vpatGuard.test.ts is the enforcement. Same dev + build wiring as the contrast
// audit above.
function vpatReportPlugin(): Plugin {
  const assets: { fileName: string; source: string; type: string }[] = [
    {
      fileName: "vpat-report.json",
      source: renderVpatJson(),
      type: "application/json",
    },
    {
      fileName: "VPAT.md",
      source: renderVpatReport("wcag"),
      type: "text/markdown; charset=utf-8",
    },
    {
      fileName: "VPAT-INT.md",
      source: renderVpatReport("int"),
      type: "text/markdown; charset=utf-8",
    },
    {
      fileName: "ACCESSIBILITY-REPORT.md",
      source: renderCombinedReport(),
      type: "text/markdown; charset=utf-8",
    },
  ]
  return {
    name: "classroom50:vpat-report",
    generateBundle() {
      for (const a of assets) {
        this.emitFile({ type: "asset", fileName: a.fileName, source: a.source })
      }
    },
    configureServer(server) {
      for (const a of assets) {
        server.middlewares.use(`/${a.fileName}`, (_req, res) => {
          res.setHeader("Content-Type", a.type)
          res.end(a.source)
        })
      }
    },
  }
}

// Dev-only bridge for the interactive WCAG assessment tool (/assess). The app
// is client-side only, so recording a verdict to the repo needs a dev endpoint;
// `apply: "serve"` keeps this middleware out of every production build (the
// endpoint simply does not exist there, and the /assess route redirects away
// unless import.meta.env.DEV). It reads/writes a single repo file,
// accessibility/vpatVerdicts.json — the machine-writable verdict overlay. The
// path is a fixed constant and ids/enums are validated server-side, so a stray
// request can't write arbitrary files or overwrite a machine-established
// (automated/contrast) row.
function assessmentApiPlugin(): Plugin {
  const verdictsPath = path.resolve(
    __dirname,
    "accessibility/vpatVerdicts.json",
  )

  const readVerdicts = (): VerdictOverlay =>
    JSON.parse(readFileSync(verdictsPath, "utf8")) as VerdictOverlay

  // The criteria + guidance the /assess UI renders from, computed fresh from
  // whatever verdicts are on disk right now.
  const dataPayload = () => {
    const overlay = readVerdicts()
    return JSON.stringify({
      criteria: buildCriteria(overlay),
      guidance: ASSESSMENT_GUIDANCE,
      verdicts: overlay,
    })
  }

  const readBody = (req: import("node:http").IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let data = ""
      req.on("data", (c) => {
        data += c
        if (data.length > 1_000_000) reject(new Error("payload too large"))
      })
      req.on("end", () => resolve(data))
      req.on("error", reject)
    })

  const VALID_STATUS = new Set(["supports", "partially", "doesNotSupport"])

  // The endpoint writes repo files with no auth, so it must reject anything that
  // isn't a genuine same-origin request from a loopback client. The Host header
  // is attacker-controlled, so it can't be the boundary: `vite --host` on an
  // untrusted network would expose the writer to anyone sending Host: localhost,
  // and a malicious tab in the dev's own browser could POST a text/plain simple
  // request (Host: localhost) as a blind CSRF write. Guard on facts the client
  // can't forge instead — the actual socket address plus a same-origin fetch
  // signal and a JSON content type (which forces a cross-origin preflight this
  // middleware never answers).
  const isLoopbackAddr = (addr: string | undefined) =>
    addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"

  // Sec-Fetch-Site is set by the browser and can't be spoofed by page JS:
  // "same-origin"/"none" (a direct navigation or a non-browser tool) is allowed,
  // cross-site is not. This is the CSRF gate the loopback bind alone can't give.
  const isSameOriginRequest = (req: import("node:http").IncomingMessage) => {
    const site = req.headers["sec-fetch-site"]
    return site === undefined || site === "same-origin" || site === "none"
  }

  // GET /_assess/data has no body, so it only needs the loopback + origin checks.
  const isAllowedRead = (req: import("node:http").IncomingMessage) =>
    isLoopbackAddr(req.socket.remoteAddress) && isSameOriginRequest(req)

  // The write path additionally requires application/json, so a cross-origin
  // simple request (text/plain, no preflight) can't reach the body parser.
  const isAllowedWrite = (req: import("node:http").IncomingMessage) => {
    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim()
    return (
      isLoopbackAddr(req.socket.remoteAddress) &&
      isSameOriginRequest(req) &&
      contentType === "application/json"
    )
  }

  return {
    name: "classroom50:assessment-api",
    apply: "serve",
    configureServer(server) {
      // Saving a verdict writes verdictsPath; without this, Vite's file watcher
      // sees the change (vpatModel imports it) and full-reloads the page mid-
      // edit. The /assess page already updates itself from the POST response,
      // so stop watching the file — a manual hand-edit just needs a refresh.
      server.watcher.unwatch(verdictsPath)

      server.middlewares.use("/_assess/data", (req, res) => {
        if (!isAllowedRead(req)) {
          res.statusCode = 403
          res.end("forbidden")
          return
        }
        try {
          res.setHeader("Content-Type", "application/json")
          res.end(dataPayload())
        } catch (err) {
          res.statusCode = 500
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : "read failed",
            }),
          )
        }
      })

      server.middlewares.use("/_assess/save", (req, res) => {
        if (!isAllowedWrite(req)) {
          res.statusCode = 403
          res.end("forbidden")
          return
        }
        if (req.method !== "POST") {
          res.statusCode = 405
          res.end("method not allowed")
          return
        }
        void (async () => {
          try {
            const { id, status, remark, assessed, clear } = JSON.parse(
              await readBody(req),
            )
            if (typeof id !== "string") {
              res.statusCode = 400
              res.end(JSON.stringify({ error: "invalid id" }))
              return
            }
            // `overlay[id] = …` / `delete overlay[id]` with a prototype key like
            // "__proto__" is a silent no-op that would let a write respond 200
            // while discarding every recorded verdict — reject reserved keys.
            if (
              id === "__proto__" ||
              id === "constructor" ||
              id === "prototype"
            ) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: "invalid id" }))
              return
            }
            const overlay = readVerdicts()

            if (clear) {
              delete overlay[id]
            } else {
              if (!VALID_STATUS.has(status)) {
                res.statusCode = 400
                res.end(JSON.stringify({ error: "invalid status" }))
                return
              }
              if (typeof remark !== "string" || remark.trim() === "") {
                res.statusCode = 400
                res.end(JSON.stringify({ error: "remark is required" }))
                return
              }
              // Stamp the assessment date so the remark carries only the finding
              // (rendered in its own column). Accept a caller-supplied real ISO
              // date for reproducible fixtures, else default to today (UTC).
              const isoDate =
                typeof assessed === "string" && isValidAssessedDate(assessed)
                  ? assessed
                  : new Date().toISOString().slice(0, 10)
              const verdict: ManualVerdict = {
                status,
                evidence: "manual",
                assessed: isoDate,
                remark,
              }
              overlay[id] = verdict
            }

            // buildCriteria throws if the id is unknown or targets a
            // non-notEvaluated row — surfaces as a 400 rather than a bad write.
            buildCriteria(overlay)

            const sorted = Object.fromEntries(
              Object.keys(overlay)
                .sort()
                .map((k) => [k, overlay[k]]),
            )
            writeFileSync(verdictsPath, JSON.stringify(sorted, null, 2) + "\n")

            res.setHeader("Content-Type", "application/json")
            res.end(dataPayload())
          } catch (err) {
            res.statusCode = 400
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : "bad request",
              }),
            )
          }
        })()
      })
    },
  }
}
export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(release.version),
    __APP_COMMIT__: JSON.stringify(release.commit),
    __APP_BUILD_DATE__: JSON.stringify(release.buildDate),
    // VITE_GITHUB_PAT is a dev-only auto-login convenience (see
    // resolveDevAutoLoginPat). Vite inlines every VITE_* value into the bundle,
    // so a token left in .env.local during `vite build` would ship to every
    // visitor — the runtime DEV guard stops *use*, not *embedding*. Hard-blank
    // the literal for any non-development build so it can never leak.
    "import.meta.env.VITE_GITHUB_PAT":
      mode === "development"
        ? JSON.stringify(
            loadEnv(mode, path.resolve(__dirname), "").VITE_GITHUB_PAT ?? "",
          )
        : JSON.stringify(""),
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
    contrastAuditPlugin(),
    vpatReportPlugin(),
    assessmentApiPlugin(),
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
    // Two projects: the fast node/happy-dom suite (the bulk of the tests) and a
    // Playwright/Chromium browser suite for the handful of checks that need a real
    // layout engine (target-size + reflow, *.browser.test.tsx). `vitest run` runs
    // both; browser tests need `npx playwright install chromium` once locally.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.{test,spec}.{ts,tsx}"],
          exclude: ["src/**/*.browser.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.tsx"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
}))
