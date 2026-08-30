import { Combobox, type InputSize } from "@/components/ui"
import type { DirectoryMember } from "@/domain/students"

// The one member-link picker recipe, shared by the roster detail modal and
// batch Edit mode: the typed-query filter (login OR classroom, case-
// insensitive), the item cap, and the login + classrooms option markup live
// only here. Callers own the candidate pool (claim/staging exclusions), the
// text/open state, and the copy — the two surfaces use different i18n keys.

// Cap what one keystroke renders; typing narrows the list, so nothing is lost.
const MAX_ITEMS = 30

export function MemberLinkPicker({
  id,
  label,
  placeholder,
  emptyState,
  items,
  value,
  open,
  frozen = false,
  inputSize,
  className,
  onInputChange,
  onOpenChange,
  onSelect,
}: {
  id: string
  label: string
  placeholder: string
  emptyState: string
  items: DirectoryMember[]
  value: string
  open: boolean
  // Swallow all input while the caller is saving — a keystroke or selection
  // would otherwise mutate the staged state mid-save.
  frozen?: boolean
  inputSize?: InputSize
  className?: string
  onInputChange: (value: string) => void
  onOpenChange: (open: boolean) => void
  onSelect: (member: DirectoryMember) => void
}) {
  const query = value.trim().toLowerCase()
  const filtered = query
    ? items.filter(
        (m) =>
          m.login.toLowerCase().includes(query) ||
          m.classrooms.some((c) => c.toLowerCase().includes(query)),
      )
    : items

  return (
    <Combobox
      id={id}
      className={className}
      label={label}
      placeholder={placeholder}
      inputSize={inputSize}
      value={value}
      onInputChange={(next) => {
        if (!frozen) onInputChange(next)
      }}
      open={open}
      onOpenChange={(next) => {
        if (!frozen) onOpenChange(next)
      }}
      items={filtered.slice(0, MAX_ITEMS)}
      getItemKey={(m) => m.login}
      getItemLabel={(m) => m.login}
      renderItem={(m) => (
        <span className="flex flex-col">
          <span className="font-mono text-sm">@{m.login}</span>
          {m.classrooms.length > 0 ? (
            <span className="text-xs text-base-content/60">
              {m.classrooms.join(", ")}
            </span>
          ) : null}
        </span>
      )}
      onSelect={(m) => {
        if (!frozen) onSelect(m)
      }}
      emptyState={emptyState}
    />
  )
}

export default MemberLinkPicker
