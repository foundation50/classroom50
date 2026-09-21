import { AnimatePresence, motion } from "motion/react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui"
import { GraphIcon } from "@/components/ui/icons"
import { useConsent } from "@/context/consent/ConsentProvider"
import { router } from "@/router"
import { toastVariants } from "@/lib/motion"

// The first-visit consent prompt: a small card in the bottom-start corner that
// never blocks the page (Primer: an awareness message, not a wall). Accept and
// Reject carry equal weight and take one click each; Customize opens the
// category dialog. It leaves once a decision exists, from any surface or tab.
// z-[45] sits above the sidebar rail (z-40) and below toasts (z-50) and the
// top-layer dialog.
export function ConsentBanner() {
  const { t } = useTranslation()
  const { needsDecision, dialogOpen, acceptAll, rejectAll, openDialog } =
    useConsent()
  const show = needsDecision && !dialogOpen
  // Rendered outside RouterProvider (a sibling of <App/>), so no <Link>; the
  // router instance navigates directly and the href keeps the link real.
  const goToPrivacy = (event: React.MouseEvent) => {
    event.preventDefault()
    void router.navigate({ to: "/privacy" })
  }

  return (
    <AnimatePresence>
      {show && (
        <motion.section
          key="consent-banner"
          variants={toastVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          role="region"
          aria-label={t("consent.banner.aria")}
          className="fixed bottom-4 start-4 z-[45] w-[calc(100%-2rem)] max-w-md rounded-box border border-base-300 bg-base-100 p-4 shadow-lg"
        >
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
            >
              <GraphIcon className="size-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="text-sm font-semibold">
                {t("consent.banner.title")}
              </h2>
              <p className="text-sm text-base-content/70">
                {t("consent.banner.body")}{" "}
                <a
                  href="/privacy"
                  className="link link-info link-hover"
                  onClick={goToPrivacy}
                >
                  {t("consent.privacyLink")}
                </a>
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={openDialog}>
              {t("consent.banner.customize")}
            </Button>
            <Button variant="outline" size="sm" onClick={rejectAll}>
              {t("consent.banner.reject")}
            </Button>
            <Button variant="outline" size="sm" onClick={acceptAll}>
              {t("consent.banner.accept")}
            </Button>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  )
}
