import { createFileRoute, redirect } from "@tanstack/react-router"
import { GitHubAuthCard } from "@/auth/GitHubAuthCard"
import { logger } from "@/lib/logger"

const log = logger.scope("router")

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
