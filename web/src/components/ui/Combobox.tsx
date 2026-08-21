import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react"

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
  // Stable id for the input; the listbox and options derive their ids from it so
  // `aria-activedescendant` can reference them.
  id: string
  // Accessible name for the input. Pass the same text as the visible field
  // label; `labelledBy` is preferred when a real <label> already exists.
  label?: string
  labelledBy?: string
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
  // Shown in place of the listbox when `items` is empty (never an empty
  // listbox, which reads as a broken widget).
  emptyState?: ReactNode
  // Pinned above the options — e.g. "showing 30 of 4213, keep typing".
  footer?: ReactNode
  // Transient state (searching, throttled). Announced politely.
  status?: ReactNode
  inputRef?: Ref<HTMLInputElement>
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
  labelledBy,
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
  inputRef,
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

  // Pointer-down outside the widget closes it. Click would fire after the
  // input's blur/refocus dance and reopen it immediately.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && wrapperRef.current?.contains(target)) return
      close()
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open, close])

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
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          open && activeIndex >= 0
            ? `${optionIdPrefix}-${activeIndex}`
            : undefined
        }
        autoComplete="off"
        ref={inputRef}
        value={value}
        onChange={(event) => {
          onInputChange(event.target.value)
          if (!open) onOpenChange(true)
        }}
        onFocus={(event) => {
          openFresh()
          inputProps.onFocus?.(event)
        }}
        onKeyDown={onKeyDown}
      />

      {open ? (
        <div className="absolute inset-x-0 top-full z-30 mt-1 rounded-box border border-base-content/10 bg-base-100 shadow-lg">
          {status ? (
            <div
              role="status"
              className="border-base-content/5 border-b px-3 py-2 text-sm text-base-content/70"
            >
              {status}
            </div>
          ) : null}

          {items.length > 0 ? (
            <ul
              id={listboxId}
              role="listbox"
              aria-label={labelledBy ? undefined : label}
              aria-labelledby={labelledBy}
              className="max-h-72 overflow-y-auto py-1"
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
          ) : emptyState ? (
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
