import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { Button, Dropdown, DropdownMenu } from "@/components/ui"
import { TriangleDownIcon, XIcon } from "@/components/ui/icons"

// The selection cluster every multi-select table shows while rows are ticked:
// count, one "Actions" menu, Clear. Rendered as a fragment so the host toolbar
// owns the layout. Menu items are `DropdownMenu.Item`s passed as children.
export function BulkSelectionCluster({
  countLabel,
  onClearSelection,
  menuClassName = "w-64",
  children,
}: {
  // Pre-translated: the noun differs per table ("3 selected", "3 assignments
  // selected").
  countLabel: string
  onClearSelection: () => void
  menuClassName?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <>
      <span className="text-sm font-medium tabular-nums">{countLabel}</span>
      {/* Start-aligned: the cluster sits at the start of its row, so the menu
          opens inward instead of off the edge. */}
      <Dropdown align="start">
        <DropdownMenu.Trigger variant="primary" size="sm">
          {t("common.actions")}
          <TriangleDownIcon aria-hidden="true" className="size-4" />
        </DropdownMenu.Trigger>
        <DropdownMenu className={menuClassName}>{children}</DropdownMenu>
      </Dropdown>
      <Button
        variant="ghost"
        size="sm"
        shape="square"
        aria-label={t("common.clearSelection")}
        title={t("common.clearSelection")}
        onClick={onClearSelection}
      >
        <XIcon aria-hidden="true" className="size-4" />
      </Button>
    </>
  )
}

export default BulkSelectionCluster
