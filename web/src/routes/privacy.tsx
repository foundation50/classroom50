import { createFileRoute } from "@tanstack/react-router"

import PrivacyPage from "@/pages/PrivacyPage"

// Public (unauthenticated) route: the privacy notice and the analytics
// opt-out, so a visitor can object before signing in.
export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
})
