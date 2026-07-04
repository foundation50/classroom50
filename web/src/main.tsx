import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
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

const client = new QueryClient()

// Make the deployed release identifiable from the browser console (there is no
// version in the URL or a server header for a static SPA). Deliberate release
// diagnostic, not stray debug logging — hence the no-console exception.
// eslint-disable-next-line no-console
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
              <ReactQueryDevtools initialIsOpen={false} />
            )}
          </GitHubClientProviderFromAuth>
        </GitHubAuthProvider>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
)
