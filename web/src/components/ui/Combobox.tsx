import {
  useCallback,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"

import { useDismissOnOutsidePointerDown } from "@/hooks/useDismissOnOutsidePointerDown"
import { cx } from "./cx"
import { Input, type InputProps } from "./Input"

// The app's only combobox. Data-free on purpose: it owns the ARIA contract,
// keyboard navigation, and the results panel, while the caller owns the text,
// the open state, and where the items come from.
//
// Two constraints drove the shape:
//   - daisyUI's CSS `dropdown` is focus-driven and closes on blur, which fights
//     a text input living inside the widget. Open state is therefore explicit
//     React state, not the CSS recipe.
//   - The panel paints outside the field's box, so nothing here may set
//     `overflow-hidden` (an ancestor that does will truncate it — see Collapse).

export type ComboboxProps<T> = {
  // Stable id for the input; the listbox id derives from it.
  id: string
  // Accessible name for the input and the listbox.
  label?: string
  value: string
  onInputChange: (value: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  items: T[]
  getItemKey: (item: T) => string
  // Plain-text form of an item, used as the option's accessible name so a
  // screen reader isn't handed the whole rich row.
  getItemLabel: (item: T) => string
  renderItem: (item: T, state: { active: boolean }) => ReactNode
  onSelect: (item: T) => void
  emptyState?: ReactNode
  footer?: ReactNode
  status?: ReactNode
} & Pick<
  InputProps,
  | "placeholder"
  | "leadingIcon"
  | "trailing"
  | "invalid"
  | "inputSize"
  | "name"
  | "onFocus"
  | "onBlur"
  | "spellCheck"
  | "aria-describedby"
  | "className"
>

export function Combobox<T>({
  id,
  label,
  value,
  onInputChange,
  open,
  onOpenChange,
  items,
  getItemKey,
  getItemLabel,
  renderItem,
  onSelect,
  emptyState,
  footer,
  status,
  className,
  ...inputProps
}: ComboboxProps<T>) {
  const listboxId = `${id}-listbox`
  const optionIdPrefix = useId()
  const wrapperRef = useRef<HTMLDivElement>(null)
  // The active option is tracked by key, not index: when the result set changes
  // under a highlight (a debounced search resolving), a key either still exists
  // — so the highlight follows the row — or it doesn't, and nothing is active.
  // An index would silently point at whatever row moved into that slot.
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const activeIndex = activeKey
    ? items.findIndex((item) => getItemKey(item) === activeKey)
    : -1
  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined

  const close = useCallback(() => {
    onOpenChange(false)
    setActiveKey(null)
  }, [onOpenChange])

  const openFresh = useCallback(() => {
    // Opening never inherits a previous highlight, so Enter can't fire a row the
    // teacher hasn't looked at since.
    setActiveKey(null)
    onOpenChange(true)
  }, [onOpenChange])

  // Pointer-down outside the widget closes it.
  useDismissOnOutsidePointerDown(wrapperRef, open, close)

  const move = (delta: number) => {
    if (items.length === 0) return
    const next =
      activeIndex === -1
        ? delta > 0
          ? 0
          : items.length - 1
        : (activeIndex + delta + items.length) % items.length
    setActiveKey(getItemKey(items[next]))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        if (!open) onOpenChange(true)
        move(1)
        return
      case "ArrowUp":
        event.preventDefault()
        if (!open) onOpenChange(true)
        move(-1)
        return
      case "Enter": {
        if (!open || !activeItem) return
        // Only swallow the key when it actually picked something, so Enter still
        // submits the surrounding form when no option is highlighted.
        event.preventDefault()
        onSelect(activeItem)
        close()
        return
      }
      case "Escape":
        if (!open) return
        event.preventDefault()
        close()
        return
      case "Tab":
        if (open) close()
        return
      default:
        return
    }
  }

  return (
    <div ref={wrapperRef} className={cx("relative", className)}>
      <Input
        {...inputProps}
        id={id}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          open && activeIndex >= 0
            ? `${optionIdPrefix}-${activeIndex}`
            : undefined
        }
        autoComplete="off"
        value={value}
        onChange={(event) => {
          onInputChange(event.target.value)
          if (!open) onOpenChange(true)
        }}
        onFocus={(event) => {
          openFresh()
          inputProps.onFocus?.(event)
        }}
        // Focus alone can't reopen the panel: after Escape or a selection the
        // input is still focused, so clicking it fires no focus event.
        onPointerDown={() => {
          if (!open) openFresh()
        }}
        onKeyDown={onKeyDown}
      />

      {open ? (
        <div
          // Pointer-down anywhere in the panel chrome would otherwise blur the
          // input (firing the field's onBlur mid-interaction). Options call
          // preventDefault themselves before selecting; the scrollable list is
          // exempted below so scrollbar drags still work.
          onPointerDown={(event) => event.preventDefault()}
          className="absolute inset-x-0 top-full z-10 mt-1 rounded-box border border-base-content/5 bg-base-100 shadow"
        >
          {status ? (
            <div
              role="status"
              className="border-base-content/5 border-b px-3 py-2 text-sm text-base-content/70"
            >
              {status}
            </div>
          ) : null}

          {/* The listbox stays mounted while open, even with no options, so the
              input's `aria-controls` always resolves to a real element. The
              empty-state message is a sibling: an empty `role="listbox"` may
              not contain non-option children. */}
          <ul
            id={listboxId}
            role="listbox"
            aria-label={label}
            // Let a scrollbar drag through: the wrapper's preventDefault would
            // otherwise cancel it.
            onPointerDown={(event) => event.stopPropagation()}
            className={cx(
              "max-h-72 overflow-y-auto",
              items.length > 0 ? "py-1" : "sr-only",
            )}
          >
            {items.map((item, index) => {
              const key = getItemKey(item)
              const active = key === activeKey
              return (
                <li
                  key={key}
                  id={`${optionIdPrefix}-${index}`}
                  role="option"
                  aria-selected={active}
                  aria-label={getItemLabel(item)}
                  // Pointer-down beats the input's blur, so the selection
                  // lands before anything can close the panel.
                  onPointerDown={(event) => {
                    event.preventDefault()
                    onSelect(item)
                    close()
                  }}
                  onMouseEnter={() => setActiveKey(key)}
                  className={cx(
                    // min-h keeps the row within the target-size audit's floor.
                    "flex min-h-11 cursor-pointer flex-col justify-center px-3 py-2 text-start",
                    active && "bg-base-200",
                  )}
                >
                  {renderItem(item, { active })}
                </li>
              )
            })}
          </ul>

          {items.length === 0 && emptyState ? (
            <div className="px-3 py-3 text-sm text-base-content/70">
              {emptyState}
            </div>
          ) : null}

          {footer ? (
            <div className="border-base-content/5 border-t px-3 py-2 text-xs text-base-content/60">
              {footer}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default Combobox
