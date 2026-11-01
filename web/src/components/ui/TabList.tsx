import type { ReactNode } from "react"

import { useRovingTabList } from "@/hooks/useRovingTabList"

import { cx } from "./cx"

// Boxed tab recipe: the active tab reads unambiguously (solid primary fill)
// and inactive tabs stay clickable-looking. One source for every tablist.
export function tabClass(active: boolean): string {
  return cx(
    "tab cursor-pointer gap-1.5",
    active
      ? "tab-active rounded-box !bg-primary font-semibold !text-primary-content"
      : "text-base-content/60 hover:text-base-content",
  )
}

// The id a tab button gets, so the panel it controls can point back at it
// with `aria-labelledby`.
export function tabId(baseId: string, key: string): string {
  return `${baseId}-tab-${key}`
}

export type TabItem<K extends string> = {
  key: K
  // A function receives whether this tab is active, for labels whose
  // secondary text (a count) has to follow the active colour.
  label: ReactNode | ((active: boolean) => ReactNode)
}

export type TabListProps<K extends string> = {
  // Base for every tab's id; pair with `tabId` on the panel.
  id: string
  tabs: readonly TabItem<K>[]
  active: K
  onChange: (key: K) => void
  // The single panel every tab controls.
  panelId: string
  size?: "sm" | "md"
  "aria-label"?: string
  className?: string
}

// WAI-ARIA tabs: click selects, arrows/Home/End rove focus (RTL-aware), only
// the active tab is in the tab order.
export function TabList<K extends string>({
  id,
  tabs,
  active,
  onChange,
  panelId,
  size = "md",
  "aria-label": ariaLabel,
  className,
}: TabListProps<K>) {
  const tabProps = useRovingTabList(
    tabs.length,
    tabs.findIndex((tab) => tab.key === active),
  )
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cx(
        "tabs-boxed tabs w-fit",
        size === "sm" && "tabs-sm",
        className,
      )}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.key === active
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={tabId(id, tab.key)}
            aria-selected={isActive}
            aria-controls={panelId}
            className={tabClass(isActive)}
            onClick={() => onChange(tab.key)}
            {...tabProps(index)}
          >
            {typeof tab.label === "function" ? tab.label(isActive) : tab.label}
          </button>
        )
      })}
    </div>
  )
}

export default TabList
