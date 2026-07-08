// Shared UI primitives: thin typed wrappers over the app's daisyUI class
// recipes so inline copy-pasted classes converge on one prop->class mapping.
// Spinner already lived at components/Spinner; re-exported here so callers have
// a single `@/components/ui` entry point.
export { Button } from "./Button"
export type {
  ButtonProps,
  ButtonVariant,
  ButtonSize,
  ButtonShape,
} from "./Button"

export { Card, CardBody, CardTitle, CardActions } from "./Card"
export type { CardProps } from "./Card"

export { Badge } from "./Badge"
export type { BadgeProps, BadgeTone, BadgeSize } from "./Badge"

export { Input } from "./Input"
export type { InputProps, InputSize } from "./Input"

export { Select } from "./Select"
export type { SelectProps, SelectSize } from "./Select"

export { Textarea } from "./Textarea"
export type { TextareaProps } from "./Textarea"

export { FormField, HelpTooltip } from "./FormField"

export { Modal } from "./Modal"
export type { ModalProps, ModalSize } from "./Modal"

export { Alert, alertToneClass } from "./Alert"
export type { AlertProps, AlertTone } from "./Alert"

export { CopyableCode } from "./CopyableCode"
export type { CopyableCodeProps } from "./CopyableCode"

export { StatCard } from "./StatCard"
export type { StatCardProps } from "./StatCard"

export { LabeledControl } from "./LabeledControl"
export type { LabeledControlProps } from "./LabeledControl"

export { Spinner } from "@/components/Spinner"

export { cx } from "./cx"
