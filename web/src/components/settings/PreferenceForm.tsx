import { useState } from "react"
import { useTranslation } from "react-i18next"

import { AnimatedAlert, Button, Radio } from "@/components/ui"
import { useOptionalToast } from "@/context/notifications/NotificationProvider"

export type PreferenceOption<T extends string> = {
  value: T
  label: string
  hint: string
}

// Radio list for a preference: each option is a bordered row (label + hint).
// `name` scopes the radios so several groups on one page don't collide.
export function PreferenceRadioGroup<T extends string>({
  name,
  legend,
  value,
  onChange,
  options,
}: {
  name: string
  legend: string
  value: T
  onChange: (next: T) => void
  options: PreferenceOption<T>[]
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const id = `${name}-${option.value}`
        const hintId = `${id}-hint`
        return (
          <label
            key={option.value}
            htmlFor={id}
            className="flex cursor-pointer items-start gap-3 rounded-field border border-base-300 px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
          >
            <Radio
              id={id}
              name={name}
              size="sm"
              tone="primary"
              className="mt-0.5"
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              aria-label={option.label}
              aria-describedby={hintId}
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium">{option.label}</span>
              <span id={hintId} className="text-xs text-base-content/60">
                {option.hint}
              </span>
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}

// Draft-and-save wrapper around PreferenceRadioGroup (Primer settings
// guidance: an explicit Save, not save-on-click). Selection edits a local
// draft; Save commits it through the pref hook. An unchanged save is a no-op
// with a notice (the house form pattern), a real save confirms inline and
// announces to SR. An external pref change (another tab, the OS) re-syncs a
// pristine draft but never clobbers in-progress edits.
export function PreferenceForm<T extends string>({
  name,
  legend,
  value,
  onSave,
  options,
  savedMessage,
}: {
  name: string
  legend: string
  value: T
  onSave: (next: T) => void
  options: PreferenceOption<T>[]
  savedMessage: string
}) {
  const { t } = useTranslation()
  // Optional: the settings page also renders in provider-less tests.
  const announce = useOptionalToast()?.announce
  const [draft, setDraft] = useState<T>(value)
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setDraft((current) => (current === lastValue ? value : current))
  }
  const [notice, setNotice] = useState<"saved" | "noChanges" | null>(null)

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (draft === value) {
          setNotice("noChanges")
          return
        }
        onSave(draft)
        setNotice("saved")
        announce?.(savedMessage)
      }}
    >
      <PreferenceRadioGroup
        name={name}
        legend={legend}
        value={draft}
        onChange={(next) => {
          setDraft(next)
          setNotice(null)
        }}
        options={options}
      />
      <AnimatedAlert
        tone="info"
        show={notice === "noChanges"}
        className="mt-3 text-sm"
      >
        {t("settings.noChangesToSave")}
      </AnimatedAlert>
      <AnimatedAlert
        tone="success"
        show={notice === "saved"}
        className="mt-3 text-sm"
      >
        {savedMessage}
      </AnimatedAlert>
      <div className="mt-4">
        <Button type="submit" variant="primary" size="sm">
          {t("common.save")}
        </Button>
      </div>
    </form>
  )
}
