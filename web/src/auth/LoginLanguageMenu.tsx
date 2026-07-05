import { useEffect, useRef, useState } from "react"
import { Check, Globe, Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useLanguage } from "@/hooks/useLanguage"
import {
  BASE_LANG,
  type RegistryLanguage,
  languageLabel,
  prepareFromBuiltIn,
} from "@/i18n/customLocale"

// Minimal language switcher for the login card. Installed languages (base +
// previously installed packs) switch instantly; registry languages load on
// mount and install on select so a first-time visitor can read the login page
// in their own language. Native names (languageLabel(code, code)) keep each
// entry legible regardless of the current UI language.
export function LoginLanguageMenu() {
  const { t } = useTranslation()
  const { lang, availableLangs, setLang, availableBuiltInLangs, commitPack } =
    useLanguage()

  const [registry, setRegistry] = useState<RegistryLanguage[] | null>(null)
  // Starts true: the mount effect always kicks off a registry fetch.
  const [loadingRegistry, setLoadingRegistry] = useState(true)
  const [registryError, setRegistryError] = useState(false)
  const [switchingCode, setSwitchingCode] = useState<string | null>(null)
  // Synchronous re-entry lock: `switchingCode` is async React state, so a fast
  // second click can fire before it re-renders. A ref flips immediately.
  const switchingRef = useRef(false)

  const label = (code: string) =>
    code === BASE_LANG ? t("language.baseName") : languageLabel(code, code)

  const loadRegistry = async () => {
    if (registry || loadingRegistry) return
    setLoadingRegistry(true)
    setRegistryError(false)
    try {
      setRegistry(await availableBuiltInLangs())
    } catch {
      // Registry unreachable: keep the installed list usable; the user can
      // retry by reopening the menu.
      setRegistryError(true)
      setRegistry(null)
    } finally {
      setLoadingRegistry(false)
    }
  }

  // Prefetch the registry on mount so the list is ready when the menu opens.
  // Set state only after the fetch resolves, and bail if unmounted mid-flight.
  useEffect(() => {
    let active = true
    availableBuiltInLangs()
      .then((langs) => {
        if (active) setRegistry(langs)
      })
      .catch(() => {
        if (active) setRegistryError(true)
      })
      .finally(() => {
        if (active) setLoadingRegistry(false)
      })
    return () => {
      active = false
    }
  }, [availableBuiltInLangs])

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
    if (switchingRef.current) return
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

  const installAndSwitch = (code: string) =>
    runSwitch(code, async () => (await prepareAndCommit(code)) !== null)

  // Fetch + install + activate a registry pack. Returns the installed code, or
  // null on failure (the menu stays open so the user can retry another).
  const prepareAndCommit = async (code: string): Promise<string | null> => {
    try {
      const preview = await prepareFromBuiltIn(code)
      await commitPack(preview.code, preview.bundle)
      // Newly installed language becomes available; reflect it locally so it
      // moves to "available now" without a second registry fetch.
      setRegistry((prev) => (prev ? prev.filter((l) => l.code !== code) : prev))
      return preview.code
    } catch {
      return null
    }
  }

  const installedSet = new Set(availableLangs)
  const more = (registry ?? []).filter((l) => !installedSet.has(l.code))

  return (
    <div className="dropdown dropdown-end">
      <button
        type="button"
        tabIndex={0}
        className="btn btn-ghost btn-sm btn-circle text-base-content/70"
        aria-label={t("language.switcherLabel")}
        title={t("language.switcherLabel")}
        onClick={() => void loadRegistry()}
      >
        <Globe aria-hidden="true" className="size-5" />
      </button>{" "}
      <ul
        tabIndex={0}
        className="dropdown-content menu z-10 mt-1 max-h-80 w-60 flex-nowrap overflow-y-auto rounded-box border border-base-content/5 bg-base-100 p-1 shadow"
      >
        <li className="menu-title text-xs">
          {t("language.switcherInstalled")}
        </li>
        {availableLangs.map((code) => (
          <li key={code}>
            <button
              type="button"
              className="flex items-center justify-between"
              onClick={() => void switchInstalled(code)}
              disabled={switchingCode !== null}
            >
              <span className="truncate">{label(code)}</span>
              {code === lang ? (
                <Check
                  className="size-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
              ) : switchingCode === code ? (
                <Loader2
                  className="size-4 shrink-0 animate-spin"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          </li>
        ))}

        {loadingRegistry && (
          <li className="px-3 py-2 text-xs text-base-content/60">
            <span className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
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
              <li key={l.code}>
                <button
                  type="button"
                  className="flex items-center justify-between"
                  onClick={() => void installAndSwitch(l.code)}
                  disabled={switchingCode !== null}
                >
                  <span className="truncate">{label(l.code)}</span>
                  {switchingCode === l.code && (
                    <Loader2
                      className="size-4 shrink-0 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </li>
            ))}
          </>
        )}
      </ul>
    </div>
  )
}

export default LoginLanguageMenu
