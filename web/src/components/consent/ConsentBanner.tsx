import { useId, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button, Modal, cx } from "@/components/ui"
import { ChevronDownIcon } from "@/components/ui/icons"
import { useConsent } from "@/context/consent/ConsentProvider"
import { DEFAULT_CHOICES, type ConsentChoices } from "@/types/consent"

import { ConsentCategoryList } from "./ConsentCategoryList"
import { PrivacyNotice } from "./PrivacyNotice"

// The first-visit consent prompt: a full-width bar along the bottom of the
// page, with the page dimmed and slightly blurred behind it so the choice
// gets attention while staying in context. The options sit in the bar with
// the defaults pre-selected; Accept saves whatever is selected, Decline turns
// every optional category off. "Read the privacy notice" grows the bar to the
// full viewport with the notice scrolling above the pinned choices, so a
// visitor can read everything before deciding (a page navigation would land
// behind the dimmed backdrop). It can't be dismissed without choosing: Esc,
// the backdrop, and the close X are all vetoed until a decision exists; Esc
// does collapse the notice.
export function ConsentBanner() {
  const { t } = useTranslation()
  const { needsDecision, decide, declineAll } = useConsent()
  const [draft, setDraft] = useState<ConsentChoices>(DEFAULT_CHOICES)
  const [noticeOpen, setNoticeOpen] = useState(false)
  // The bar stays mounted while closed, so each showing starts from the
  // defaults again (a Reset after unchecking something must not remember it).
  const [wasOpen, setWasOpen] = useState(needsDecision)
  if (needsDecision !== wasOpen) {
    setWasOpen(needsDecision)
    if (needsDecision) {
      setDraft(DEFAULT_CHOICES)
      setNoticeOpen(false)
    }
  }
  const titleId = useId()
  const noticeId = useId()

  return (
    <Modal
      open={needsDecision}
      placement="bottom"
      backdrop="focus"
      size="full"
      role="alertdialog"
      aria-labelledby={titleId}
      // Vetoes Esc/backdrop/X while a decision is pending; releasing it in the
      // same render as `open` flips lets the decision close the dialog.
      closeDisabled={needsDecision}
      hideCloseButton
      onKeyDown={(event) => {
        if (event.key === "Escape" && noticeOpen) setNoticeOpen(false)
      }}
      boxClassName={cx(
        "rounded-b-none border-t border-base-300 p-0",
        // Expanded: the box is the viewport, the notice scrolls, the choices
        // stay pinned. The clip is on the box, not a motion element, and the
        // scroll region inside keeps focus rings visible.
        noticeOpen && "flex h-dvh max-h-dvh flex-col overflow-hidden",
      )}
    >
      {noticeOpen && (
        <div
          id={noticeId}
          className="min-h-0 flex-1 overflow-y-auto border-b border-base-300 px-6 py-6 sm:px-8"
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <h3 className="text-lg font-semibold">
                {t("privacy.pageTitle")}
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setNoticeOpen(false)}
              >
                <ChevronDownIcon aria-hidden="true" className="size-4" />
                {t("consent.banner.hideNotice")}
              </Button>
            </div>
            <PrivacyNotice idPrefix="consent-notice" />
          </div>
        </div>
      )}

      <div className="px-6 py-5 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-10">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 id={titleId} className="text-base font-semibold">
                {t("consent.banner.title")}
              </h2>
              <p className="text-sm text-base-content/70">
                {t("consent.banner.body")}{" "}
                <button
                  type="button"
                  className="link link-info link-hover"
                  aria-expanded={noticeOpen}
                  aria-controls={noticeOpen ? noticeId : undefined}
                  onClick={() => setNoticeOpen((open) => !open)}
                >
                  {t(
                    noticeOpen
                      ? "consent.banner.hideNotice"
                      : "consent.banner.readNotice",
                  )}
                </button>
              </p>
            </div>
            <ConsentCategoryList
              variant="compact"
              idPrefix="consent-prompt"
              choices={draft}
              onChange={(category, granted) =>
                setDraft((current) => ({ ...current, [category]: granted }))
              }
            />
          </div>
          <div className="flex shrink-0 items-center gap-2 self-center">
            <Button variant="neutral" size="sm" onClick={declineAll}>
              {t("consent.banner.decline")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => decide(draft)}>
              {t("consent.banner.accept")}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
