import { createFileRoute, redirect } from "@tanstack/react-router"

import AssessmentPage from "@/pages/AssessmentPage"

// Dev-only interactive WCAG assessment tool (/assess). Its write endpoint
// (assessmentApiPlugin, serving /_assess/data + /_assess/save) is serve-only, so
// it never exists in a production build; this beforeLoad guard is the
// belt-and-suspenders that also keeps the page inert if the bundle is ever
// served with these files present.
export const Route = createFileRoute("/assess")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw redirect({ to: "/" })
    }
  },
  component: AssessmentPage,
})
