import type { ReactNode } from "react"
import { X } from "lucide-react"
import { motion } from "motion/react"
import { useTranslation } from "react-i18next"

import { collapseVariants } from "@/lib/motion"

export type AppBannerTone = "error" | "warning" | "success"

// Full-bleed vs. constrained: the coloured bar spans the viewport, but its
// contents align with the page below via the inner max-w container.
const TONE_CLASS: Record<AppBannerTone, { bar: string; icon: string }> = {
  error: {
    bar: "border-error/20 bg-error/10 text-base-content",
    icon: "text-error",
  },
  warning: {
    bar: "border-warning/25 bg-warning/10 text-base-content",
    icon: "text-warning",
  },
  success: {
    bar: "border-success/25 bg-success/10 text-base-content",
    icon: "text-success",
  },
}

// Presentational shell for a global, full-bleed banner pinned to the top (above
// routed content). Height-collapses on exit via collapseVariants so a dismissed
// banner leaves no gap. Owns only chrome — callers supply copy, actions, icon.
// Wrap in <AnimatePresence> and set a stable `key` on this element
// (AnimatePresence tracks its direct child's key).
export const AppBanner = ({
  tone,
  icon,
  title,
  children,
  onDismiss,
}: {
  tone: AppBannerTone
  icon: ReactNode
  title: string
  children: ReactNode
  onDismiss?: () => void
}) => {
  const tokens = TONE_CLASS[tone]
  const { t } = useTranslation()
  return (
    <motion.div
      role="alert"
      variants={collapseVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className={`overflow-hidden border-b text-sm ${tokens.bar}`}
    >
      <div className="mx-auto flex w-full max-w-5xl items-start gap-3 px-6 py-3">
        <span className={`mt-0.5 shrink-0 ${tokens.icon}`}>{icon}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="font-semibold text-base-content">{title}</p>
          {children}
        </div>
        {onDismiss ? (
          <button
            type="button"
            aria-label={t("components.banner.dismiss")}
            className="btn btn-ghost btn-xs btn-square -mr-1 shrink-0"
            onClick={onDismiss}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        ) : null}
      </div>
    </motion.div>
  )
}

export default AppBanner
