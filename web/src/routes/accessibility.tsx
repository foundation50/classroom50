import { createFileRoute } from "@tanstack/react-router"

import AccessibilityPage from "@/pages/AccessibilityPage"

// Public (unauthenticated) route: the WCAG 2.2 contrast audit, readable by an
// ADA/VPAT reviewer without a GitHub login.
export const Route = createFileRoute("/accessibility")({
  component: AccessibilityPage,
})
