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

export { RouterButton } from "./RouterButton"

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

export { AnimatedAlert } from "./AnimatedAlert"
export type { AnimatedAlertProps } from "./AnimatedAlert"

export { CopyableCode } from "./CopyableCode"
export type { CopyableCodeProps } from "./CopyableCode"

export { CopyableDetails } from "./CopyableDetails"
export type { CopyableDetailsProps } from "./CopyableDetails"

export { FileDropzone } from "./FileDropzone"
export type { FileDropzoneProps, PickedFile } from "./FileDropzone"

export { StatCard } from "./StatCard"
export type { StatCardProps } from "./StatCard"

export { TablePagination } from "./TablePagination"
export type { TablePaginationProps } from "./TablePagination"

export { LabeledControl } from "./LabeledControl"
export type { LabeledControlProps } from "./LabeledControl"

export { Markdown } from "./Markdown"
export type { MarkdownProps } from "./Markdown"

export { EmphasisLtr } from "./EmphasisLtr"
export type { EmphasisLtrProps } from "./EmphasisLtr"
export { MonoLtr } from "./MonoLtr"
export type { MonoLtrProps } from "./MonoLtr"

export { Toolbar } from "./Toolbar"
export type {
  ToolbarProps,
  ToolbarSearchProps,
  ToolbarFilterSelectProps,
  ToolbarTrailingProps,
  ToolbarSelectionProps,
} from "./Toolbar"

export { Spinner } from "@/components/Spinner"

export { cx } from "./cx"
export { hasUtility } from "./cx"

export { rtlFlip } from "./icons"
