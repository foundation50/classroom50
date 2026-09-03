import { useRef, useState } from "react"
import { InlineSpinner } from "@/components/Spinner"
import { CheckIcon, GlobeIcon, SyncIcon } from "@/components/ui/icons"
import { useTranslation } from "react-i18next"

import { Button, DropdownMenu, cx } from "@/components/ui"
import { useLanguage } from "@/hooks/useLanguage"
import { useLanguageRegistry } from "@/hooks/useLanguageRegistry"
import { BASE_LANG, languageLabel } from "@/i18n/customLocale"

// Minimal language switcher for the login card. Installed languages (base +
// previously installed packs) switch instantly; registry languages load on
// mount and install on select so a first-time visitor can read the login page
// in their own language. Native names (languageLabel(code, code)) keep each
// entry legible regardless of the current UI language.
export function LoginLanguageMenu() {
  const { t } = useTranslation()
  const { lang, availableLangs, setLang } = useLanguage()
  const {
    offered: more,
    loading: loadingRegistry,
    refreshing,
    refreshed,
    error: registryError,
    loadRegistry,
    refresh,
    installAndActivate,
  } = useLanguageRegistry()

  const [switchingCode, setSwitchingCode] = useState<string | null>(null)
  // Synchronous re-entry lock: `switchingCode` is async React state, so a fast
  // second click can fire before it re-renders. A ref flips immediately.
  const switchingRef = useRef(false)

  // The menu is focus-driven (see closeMenu), so nothing in it may take the
  // `disabled` attribute while busy: the browser drops focus from a disabled
  // element, which would close the menu on the very click that started the
  // work. Items go inert via aria-disabled + a click guard instead, with
  // `menu-disabled` on the <li> for the muted look.
  const inert = switchingCode !== null || refreshing

  const label = (code: string) =>
    code === BASE_LANG ? t("language.baseName") : languageLabel(code, code)

  const closeMenu = () => {
    // daisyUI dropdowns are focus-driven; blurring the focused element closes
    // the menu after a selection.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  }

  // Guarded switch: the ref-lock + spinner-code bookkeeping is identical for
  // both entry points; only the awaited work differs. `action` returns whether
  // to close the menu (true on a successful switch/install).
  const runSwitch = async (code: string, action: () => Promise<boolean>) => {
    if (switchingRef.current || refreshing) return
    switchingRef.current = true
    setSwitchingCode(code)
    try {
      if (await action()) closeMenu()
    } finally {
      setSwitchingCode(null)
      switchingRef.current = false
    }
  }

  const switchInstalled = (code: string) =>
    runSwitch(code, async () => {
      await setLang(code)
      return true
    })

  // Install + activate a registry pack. On failure the menu stays open so the
  // user can retry another (installAndActivate throws; swallow to keep it open).
  const installAndSwitch = (code: string) =>
    runSwitch(code, async () => {
      try {
        await installAndActivate(code)
        return true
      } catch {
        return false
      }
    })

  return (
    <div className="dropdown dropdown-end">
      <Button
        variant="ghost"
        size="sm"
        shape="circle"
        className="text-base-content/70"
        tabIndex={0}
        aria-label={t("language.switcherLabel")}
        title={t("language.switcherLabel")}
        onClick={() => void loadRegistry()}
      >
        <GlobeIcon aria-hidden="true" className="size-4" />
      </Button>{" "}
      <DropdownMenu className="max-h-80 w-60 flex-nowrap overflow-y-auto">
        <li className="menu-title text-xs">
          {t("language.switcherInstalled")}
        </li>
        {availableLangs.map((code) => (
          <li key={code} className={inert ? "menu-disabled" : undefined}>
            <button
              type="button"
              className="flex items-center justify-between"
              onClick={() => void switchInstalled(code)}
              aria-disabled={inert || undefined}
            >
              <span className="truncate">{label(code)}</span>
              {code === lang ? (
                <CheckIcon
                  className="size-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
              ) : switchingCode === code ? (
                <InlineSpinner className="shrink-0" />
              ) : null}
            </button>
          </li>
        ))}

        {loadingRegistry && (
          <li className="px-3 py-2 text-xs text-base-content/60">
            <span className="flex items-center gap-2">
              <InlineSpinner />
              {t("language.browseLoading")}
            </span>
          </li>
        )}

        {registryError && !loadingRegistry && (
          <li className="px-3 py-2 text-xs text-error">
            {t("language.errorRegistry")}
          </li>
        )}

        {more.length > 0 && (
          <>
            <li className="menu-title text-xs">{t("language.switcherMore")}</li>
            {more.map((l) => (
              <li key={l.code} className={inert ? "menu-disabled" : undefined}>
                <button
                  type="button"
                  className="flex items-center justify-between"
                  onClick={() => void installAndSwitch(l.code)}
                  aria-disabled={inert || undefined}
                >
                  <span className="truncate">{label(l.code)}</span>
                  {switchingCode === l.code && (
                    <InlineSpinner className="shrink-0" />
                  )}
                </button>
              </li>
            ))}
          </>
        )}

        {/* Refresh past the browser's cached manifest so a language published
            since the last visit shows up without a hard reload. Hidden while
            the first load is still in flight (nothing to refresh yet). */}
        {!loadingRegistry && (
          <li
            className={cx(
              "mt-1 border-t border-base-300 pt-1",
              switchingCode !== null && "menu-disabled",
            )}
          >
            <button
              type="button"
              className="flex items-center gap-2 text-xs text-base-content/70"
              onClick={() => {
                if (inert) return
                void refresh()
              }}
              aria-disabled={inert || undefined}
              aria-live="polite"
            >
              {refreshing ? (
                <InlineSpinner className="shrink-0" />
              ) : refreshed ? (
                <CheckIcon
                  className="size-4 shrink-0 text-success"
                  aria-hidden="true"
                />
              ) : (
                <SyncIcon className="size-4 shrink-0" aria-hidden="true" />
              )}
              {refreshed
                ? t("language.refreshDone")
                : t("language.refreshList")}
            </button>
          </li>
        )}
      </DropdownMenu>
    </div>
  )
}

export default LoginLanguageMenu
