import { createFileRoute, redirect } from "@tanstack/react-router"
import { GitHubAuthCard } from "@/auth/GitHubAuthCard"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_ROUTER } from "@/lib/logScopes"

const log = logger.scope(LOG_SCOPE_ROUTER)

export const Route = createFileRoute("/auth/")({
  component: GitHubAuthCard,
  beforeLoad: ({ context }) => {
    const { auth } = context
    if (auth.status === "authenticated") {
      log.info("already authenticated, redirecting away from /auth to /")
      throw redirect({
        to: "/",
      })
    }
  },
})
