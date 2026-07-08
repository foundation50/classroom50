import { useTranslation } from "react-i18next"

import { Modal, StatCard } from "@/components/ui"

// The submission metrics, consolidated behind a single toolbar button so they
// no longer push the roster down. Pure presentation: the page computes the
// numbers and passes the shortcut callbacks (which also close the modal, since
// they change the table's filters underneath it).
export function MetricsModal({
  open,
  onClose,
  isGroup,
  submitted,
  rosterCount,
  avgScore,
  maxScore,
  notAvailableLabel,
  passing,
  passingEnabled,
  passingDenom,
  failing,
  ungraded,
  onShowFailing,
  acceptedAvailable,
  acceptedCount,
  acceptedNotSubmitted,
  onShowAcceptedNotSubmitted,
}: {
  open: boolean
  onClose: () => void
  isGroup: boolean
  submitted: number
  rosterCount: number
  avgScore: number | null
  maxScore: number | undefined
  notAvailableLabel: string
  passing: number
  passingEnabled: boolean
  passingDenom: number
  failing: number
  ungraded: number
  onShowFailing: () => void
  acceptedAvailable: boolean
  acceptedCount: number
  acceptedNotSubmitted: number
  onShowAcceptedNotSubmitted: () => void
}) {
  const { t } = useTranslation()

  const close = () => onClose()
  const runShortcut = (fn: () => void) => {
    fn()
    close()
  }

  return (
    <Modal open={open} onClose={onClose} size="2xl">
      <h3 className="text-lg font-bold">{t("submissions.metrics.title")}</h3>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <StatCard
          label={
            isGroup
              ? t("submissions.stats.groupsSubmitted")
              : t("submissions.stats.submitted")
          }
          value={submitted}
          outOf={isGroup ? undefined : rosterCount}
        />
        <StatCard
          label={t("submissions.stats.classAverage")}
          value={
            !maxScore ? notAvailableLabel : (avgScore ?? notAvailableLabel)
          }
          outOf={maxScore || undefined}
        />
        {passingEnabled && (
          <StatCard
            label={t("submissions.stats.passing")}
            value={passingDenom === 0 ? notAvailableLabel : passing}
            outOf={passingDenom === 0 ? undefined : passingDenom}
            hint={
              passingDenom === 0 ? undefined : (
                <span className="text-xs text-base-content/70">
                  {failing > 0 ? (
                    <button
                      type="button"
                      className="link link-hover decoration-dotted underline-offset-2 hover:text-error"
                      onClick={() => runShortcut(onShowFailing)}
                      title={t("submissions.stats.showFailing")}
                    >
                      {t("submissions.stats.failingCount", { count: failing })}
                    </button>
                  ) : (
                    <>
                      {t("submissions.stats.failingCount", { count: failing })}
                    </>
                  )}
                  {ungraded > 0
                    ? t("submissions.stats.ungradedSuffix", { count: ungraded })
                    : ""}
                </span>
              )
            }
          />
        )}
        {acceptedAvailable ? (
          <StatCard
            label={t("submissions.stats.accepted")}
            value={acceptedCount}
            outOf={rosterCount}
            hint={
              acceptedNotSubmitted > 0 ? (
                <button
                  type="button"
                  className="link link-hover w-fit text-xs text-base-content/70 decoration-dotted underline-offset-2 hover:text-warning"
                  onClick={() => runShortcut(onShowAcceptedNotSubmitted)}
                  title={t("submissions.stats.showAcceptedNotSubmitted")}
                >
                  {t("submissions.stats.notYetSubmitted", {
                    count: acceptedNotSubmitted,
                  })}
                </button>
              ) : undefined
            }
          />
        ) : null}
      </div>
    </Modal>
  )
}

export default MetricsModal
