import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { MotionConfig } from "motion/react"

import "./index.css"
import "./i18n"
import { GitHubAuthProvider } from "./auth/useGithubAuth"
import { GitHubClientProviderFromAuth } from "./context/github/GitHubClientProviderFromAuth"
import { NotificationProvider } from "./context/notifications/NotificationProvider"
import { ActionActivityProvider } from "./context/actions/ActionActivityProvider"
import { ActionsBanner } from "./components/status/ActionsBanner"
import { LanguagePackUpdateToaster } from "./components/settings/LanguagePackUpdateToaster"
import App from "./App"
import { appVersion, formatAppVersion } from "./version"
import { installDiagnosticsHandlers } from "./lib/diagnostics/globalHandlers"
import { recordError } from "./lib/activity/activityStore"
import { RateLimitOverlay } from "./components/dev/RateLimitOverlay"

// Record every failed mutation as session activity. Mutations are the app's
// real write operations (create/delete/dispatch/enroll), so a rejection here is
// a genuine, user-affecting failure — unlike the benign existence-check 404s on
// the read path, which are caught and turned into verdicts and so never reach
// this cache. The mutationId dedups against a matching error toast.
const client = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      recordError(error, { dedupKey: `mutation-${mutation.mutationId}` })
    },
  }),
})

// Capture async / out-of-render errors for the activity store. Passive —
// records only, never swallows.
installDiagnosticsHandlers()

// Make the deployed release identifiable from the browser console (a static SPA
// has no version in the URL or a server header). Deliberate release diagnostic,
// not stray debug logging — it must print even in prod, so it stays a direct
// console call (allowed for main.tsx in eslint.config.js) rather than going
// through the DEV-gated logger.
console.info(
  `Classroom 50 — ${formatAppVersion()} — built ${appVersion.buildDate}`,
)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={client}>
        <GitHubAuthProvider>
          <GitHubClientProviderFromAuth>
            <ActionActivityProvider>
              <NotificationProvider>
                <App />
                <ActionsBanner />
                <LanguagePackUpdateToaster />
              </NotificationProvider>
            </ActionActivityProvider>
            {import.meta.env.DEV && (
              <>
                <ReactQueryDevtools initialIsOpen={false} />
                <RateLimitOverlay />
              </>
            )}
          </GitHubClientProviderFromAuth>
        </GitHubAuthProvider>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
)
