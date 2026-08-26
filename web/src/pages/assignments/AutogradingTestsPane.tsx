import { useEffect, useId, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { ChevronRightIcon, PencilIcon, TrashIcon } from "@/components/ui/icons"
import { EmptyState } from "@/components/list"
import { useRevealOnExpand } from "@/hooks/useRevealOnExpand"
import type { AssignmentForm } from "./assignmentFormModel"

import {
  FormField,
  Badge,
  Button,
  Collapse,
  cx,
  Input,
  Modal,
  Select,
  TableShell,
  Textarea,
} from "@/components/ui"
import type { AssignmentTestDraft } from "@/util/assignmentTests"
import {
  emptyTestDraft,
  TEST_TIMEOUT_MAX_SECONDS,
  validateTestDraft,
} from "@/util/assignmentTests"
import type { AssignmentTestComparison } from "@/types/classroom"

const TYPE_OPTIONS = [
  {
    value: "io",
    labelKey: "assignments.autograder.type.io.label",
    hintKey: "assignments.autograder.type.io.hint",
  },
  {
    value: "run",
    labelKey: "assignments.autograder.type.run.label",
    hintKey: "assignments.autograder.type.run.hint",
  },
  {
    value: "python",
    labelKey: "assignments.autograder.type.python.label",
    hintKey: "assignments.autograder.type.python.hint",
  },
] as const

type TestErrors = Partial<Record<keyof AssignmentTestDraft, string>>

// Editor works on a local copy; nothing reaches the form's `tests` until commit.
// `mode` routes commit (append vs overwrite at `index`); `baseline` is the
// opening state the dirty check compares against.
type EditorState = {
  mode: "new" | "edit"
  index: number
  baseline: AssignmentTestDraft
}

type AutogradingTestModalProps = {
  editor: EditorState
  dialogRef: React.RefObject<HTMLDialogElement | null>
  otherNames: string[]
  onCancel: () => void
  onCommit: (draft: AssignmentTestDraft) => void
}

const AutogradingTestModal = ({
  editor,
  dialogRef,
  otherNames,
  onCancel,
  onCommit,
}: AutogradingTestModalProps) => {
  const { t } = useTranslation()
  const fieldId = useId()
  const [draft, setDraft] = useState<AssignmentTestDraft>(editor.baseline)
  const [errors, setErrors] = useState<TestErrors>({})

  const set = <K extends keyof AssignmentTestDraft>(
    key: K,
    value: AssignmentTestDraft[K],
  ) => setDraft((prev) => ({ ...prev, [key]: value }))

  const dirty = !draftsEqual(draft, editor.baseline)

  const handleCommit = () => {
    const found = validateTestDraft(draft, otherNames)
    setErrors(found)
    if (Object.keys(found).length === 0) onCommit(draft)
  }

  const field = (name: keyof AssignmentTestDraft) => `${fieldId}-${name}`

  return (
    <Modal
      dialogRef={dialogRef}
      size="3xl"
      boxClassName="max-h-[90vh]"
      title={t("assignments.autograder.editTest", { number: editor.index + 1 })}
      subtitle={t("assignments.autograder.editTestHint")}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={handleCommit} disabled={!dirty}>
            {editor.mode === "new"
              ? t("assignments.autograder.addTest")
              : t("common.save")}
          </Button>
        </>
      }
      onClose={onCancel}
      onKeyDown={(e) => {
        // Enter inside a modal input would implicitly submit the surrounding
        // create-assignment form (this modal renders inside it). Repurpose as
        // commit; textareas keep Enter for newlines.
        if (
          e.key === "Enter" &&
          e.target instanceof HTMLElement &&
          e.target.tagName !== "TEXTAREA" &&
          e.target.tagName !== "BUTTON"
        ) {
          e.preventDefault()
          if (dirty) handleCommit()
        }
      }}
    >
      <div className="mt-6 space-y-5">
        <FormField
          htmlFor={field("name")}
          label={t("assignments.autograder.testName")}
          error={errors.name}
        >
          {({ id, describedById, invalid }) => (
            <Input
              id={id}
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={t("assignments.autograder.testNamePlaceholder")}
              invalid={invalid}
              aria-describedby={describedById}
            />
          )}
        </FormField>

        <fieldset>
          <legend className="label font-bold">
            {t("assignments.autograder.testType")}
          </legend>
          <div className="join w-full">
            {TYPE_OPTIONS.map((option) => (
              <input
                key={option.value}
                type="radio"
                className="join-item btn btn-sm"
                name={`${fieldId}-type`}
                aria-label={t(option.labelKey)}
                checked={draft.type === option.value}
                onChange={() => set("type", option.value)}
              />
            ))}
          </div>
          <p className="text-sm pt-1 text-base-content/70">
            {(() => {
              const hintKey = TYPE_OPTIONS.find(
                (o) => o.value === draft.type,
              )?.hintKey
              return hintKey ? t(hintKey) : null
            })()}
          </p>
        </fieldset>

        <FormField
          htmlFor={field("setup")}
          label={t("assignments.autograder.setupCommand")}
        >
          {({ id }) => (
            <Input
              id={id}
              className="font-mono"
              value={draft.setup}
              onChange={(e) => set("setup", e.target.value)}
              placeholder={t("assignments.autograder.setupCommandPlaceholder")}
            />
          )}
        </FormField>

        <FormField
          htmlFor={field("run")}
          label={t("assignments.autograder.runCommand")}
          error={errors.run}
        >
          {({ id, describedById, invalid }) => (
            <Input
              id={id}
              className="font-mono"
              value={draft.run}
              onChange={(e) => set("run", e.target.value)}
              placeholder={t("assignments.autograder.runCommandPlaceholder")}
              invalid={invalid}
              aria-describedby={describedById}
            />
          )}
        </FormField>

        {draft.type === "io" && (
          <>
            <FormField
              htmlFor={field("input")}
              label={t("assignments.autograder.input")}
            >
              {({ id }) => (
                <Textarea
                  id={id}
                  className="font-mono"
                  value={draft.input}
                  onChange={(e) => set("input", e.target.value)}
                  placeholder={t("assignments.autograder.inputPlaceholder")}
                  rows={3}
                />
              )}
            </FormField>

            <FormField
              htmlFor={field("expected")}
              label={t("assignments.autograder.expectedOutput")}
              error={errors.expected}
            >
              {({ id, describedById, invalid }) => (
                <Textarea
                  id={id}
                  className="font-mono"
                  value={draft.expected}
                  onChange={(e) => set("expected", e.target.value)}
                  placeholder={t(
                    "assignments.autograder.expectedOutputPlaceholder",
                  )}
                  rows={5}
                  invalid={invalid}
                  aria-describedby={describedById}
                />
              )}
            </FormField>

            <FormField
              htmlFor={field("comparison")}
              label={t("assignments.autograder.comparison")}
            >
              {({ id }) => (
                <Select
                  id={id}
                  value={draft.comparison}
                  onChange={(e) =>
                    set(
                      "comparison",
                      e.target.value as AssignmentTestComparison,
                    )
                  }
                >
                  <option value="included">
                    {t("assignments.autograder.comparisonIncluded")}
                  </option>
                  <option value="exact">
                    {t("assignments.autograder.comparisonExact")}
                  </option>
                  <option value="regex">
                    {t("assignments.autograder.comparisonRegex")}
                  </option>
                </Select>
              )}
            </FormField>
          </>
        )}

        {draft.type === "run" && (
          <FormField
            htmlFor={field("exitCode")}
            label={t("assignments.autograder.exitCode")}
            error={errors.exitCode}
            hint={t("assignments.autograder.exitCodeHint")}
          >
            {({ id, describedById, invalid }) => (
              <Input
                id={id}
                className="w-32"
                type="number"
                min={0}
                max={255}
                step={1}
                value={draft.exitCode}
                onChange={(e) =>
                  set(
                    "exitCode",
                    e.target.value === "" ? "" : e.target.valueAsNumber,
                  )
                }
                placeholder="0"
                invalid={invalid}
                aria-describedby={describedById}
              />
            )}
          </FormField>
        )}

        {draft.type === "python" && (
          <p className="rounded-box border border-dashed p-3 text-sm opacity-70">
            <Trans
              i18nKey="assignments.autograder.pythonNote"
              components={{ code: <code dir="ltr" /> }}
            />
          </p>
        )}

        <div className="flex gap-8">
          <FormField
            htmlFor={field("timeout")}
            label={t("assignments.autograder.timeout")}
            error={errors.timeout}
            hint={t("assignments.autograder.timeoutHint")}
          >
            {({ id, describedById, invalid }) => (
              <Input
                id={id}
                className="w-32"
                type="number"
                min={0}
                max={TEST_TIMEOUT_MAX_SECONDS}
                step={1}
                value={draft.timeout}
                onChange={(e) =>
                  set(
                    "timeout",
                    e.target.value === "" ? 0 : e.target.valueAsNumber,
                  )
                }
                invalid={invalid}
                aria-describedby={describedById}
              />
            )}
          </FormField>

          <FormField
            htmlFor={field("points")}
            label={t("assignments.autograder.points")}
            error={errors.points}
          >
            {({ id, describedById, invalid }) => (
              <Input
                id={id}
                className="w-32"
                type="number"
                min={0}
                max={1000}
                step={1}
                value={draft.points}
                onChange={(e) =>
                  set(
                    "points",
                    e.target.value === "" ? 0 : e.target.valueAsNumber,
                  )
                }
                invalid={invalid}
                aria-describedby={describedById}
              />
            )}
          </FormField>
        </div>
      </div>
    </Modal>
  )
}

// Drives the editor's dirty check so an untouched draft can't be committed.
// Safe as a key-by-key `===` because every draft field is a primitive.
export const draftsEqual = (
  a: AssignmentTestDraft,
  b: AssignmentTestDraft,
): boolean =>
  (Object.keys(a) as (keyof AssignmentTestDraft)[]).every(
    (key) => a[key] === b[key],
  )

const typeBadge = (type: AssignmentTestDraft["type"], t: TFunction) => {
  const labelKey = TYPE_OPTIONS.find((o) => o.value === type)?.labelKey
  return labelKey ? t(labelKey) : type
}

const AutogradingTestsPane = ({ form }: { form: AssignmentForm }) => {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  // The test list collapses so a long table doesn't bury the Advanced settings
  // below it. Seeded open when tests already exist (an edited assignment shows
  // its tests up front); a fresh assignment starts collapsed.
  const [expanded, setExpanded] = useState(
    () => form.getFieldValue("tests").length > 0,
  )
  const { bodyRef, reveal } = useRevealOnExpand()

  useEffect(() => {
    if (!editor) return
    const dialog = dialogRef.current
    if (!dialog || dialog.open) return
    dialog.showModal()
  }, [editor])

  const openNewEditor = () => {
    setEditor({
      mode: "new",
      index: form.getFieldValue("tests").length,
      baseline: emptyTestDraft(),
    })
  }

  const openEditEditor = (index: number) => {
    setEditor({
      mode: "edit",
      index,
      baseline: form.getFieldValue("tests")[index],
    })
  }

  const closeEditor = () => {
    const dialog = dialogRef.current
    if (dialog?.open) dialog.close()
    setEditor(null)
  }

  // The only path from a local draft into the form. Cancel/Escape/backdrop
  // never reach it, so an abandoned draft leaves the list unchanged.
  const commitEditor = (draft: AssignmentTestDraft) => {
    if (!editor) return
    if (editor.mode === "new") {
      form.pushFieldValue("tests", draft)
    } else {
      form.setFieldValue(`tests[${editor.index}]`, draft)
    }
    // Reveal the list so the just-saved test is visible rather than landing
    // inside a collapsed section.
    setExpanded(true)
    reveal()
    closeEditor()
  }

  const otherNames = (tests: AssignmentTestDraft[], active: EditorState) =>
    tests
      .filter((_, i) => active.mode === "new" || i !== active.index)
      .map((d) => d.name.trim())
  return (
    <div>
      <form.Field name="tests" mode="array">
        {(field) => (
          <>
            <div className="flex items-start justify-between gap-3">
              {/* The heading doubles as the collapse toggle; the count/points
                  summary stays visible while collapsed so a teacher can see
                  what's configured without expanding. */}
              <button
                type="button"
                onClick={() => {
                  const next = !expanded
                  setExpanded(next)
                  if (next) reveal()
                }}
                aria-expanded={expanded}
                className="group flex cursor-pointer items-start gap-1.5 text-start"
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className={cx(
                    "mt-1 size-4 shrink-0 transition-transform duration-200",
                    expanded
                      ? "rotate-90 group-hover:translate-y-0.5"
                      : "ltr:group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5",
                  )}
                />
                <span>
                  <span className="block text-base font-bold">
                    {t("assignments.autograder.heading")}
                  </span>
                  <span className="block text-sm opacity-70">
                    <form.Subscribe selector={(state) => state.values.tests}>
                      {(tests) => (
                        <>
                          {t("assignments.autograder.summary", {
                            count: tests.length,
                            points: tests.reduce(
                              (sum: number, test: AssignmentTestDraft) =>
                                sum + test.points,
                              0,
                            ),
                          })}
                        </>
                      )}
                    </form.Subscribe>
                  </span>
                </span>
              </button>
              <div>
                <Button variant="outline" onClick={openNewEditor}>
                  {t("assignments.autograder.addTest")}
                </Button>
              </div>
            </div>
            {/* Gap between the header row and the table lives on the animating
                element (padding, not a child margin) so the collapse height
                accounts for it. */}
            <Collapse open={expanded} bodyRef={bodyRef} className="pt-4">
              {/* Same TableShell frame as the app's other data tables, so the
                  tests list can't drift from the house table treatment. */}
              <TableShell animate={false} padded>
                <caption className="sr-only">
                  {t("assignments.autograder.heading")}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t("assignments.autograder.testName")}</th>
                    <th scope="col">{t("assignments.autograder.colType")}</th>
                    <th scope="col">
                      {t("assignments.autograder.runCommand")}
                    </th>
                    <th scope="col">{t("assignments.autograder.points")}</th>
                    <th scope="col" className="w-0">
                      <span className="sr-only">
                        {t("assignments.autograder.colActions")}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {field.state.value.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <EmptyState
                          variant="bare"
                          className="py-6"
                          body={t("assignments.autograder.empty")}
                        />
                      </td>
                    </tr>
                  ) : (
                    field.state.value.map(
                      (test: AssignmentTestDraft, index: number) => (
                        <tr key={index}>
                          <td>
                            <div className="font-bold max-w-[12rem] truncate">
                              {test.name ||
                                t("assignments.autograder.testFallback", {
                                  number: index + 1,
                                })}
                            </div>
                          </td>

                          <td>
                            <Badge ghost>{typeBadge(test.type, t)}</Badge>
                          </td>

                          <td>
                            <pre className="max-w-[12rem] truncate rounded bg-base-200 p-2 text-xs">
                              {test.run || "-"}
                            </pre>
                          </td>

                          <td>
                            <Badge tone="primary">{test.points}</Badge>
                          </td>

                          <td className="w-0 ps-2">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                shape="square"
                                onClick={() => openEditEditor(index)}
                                aria-label={t(
                                  "assignments.autograder.editTest",
                                  {
                                    number: index + 1,
                                  },
                                )}
                              >
                                <PencilIcon
                                  aria-hidden="true"
                                  className="size-4"
                                />
                              </Button>

                              <Button
                                variant="ghost"
                                size="sm"
                                shape="square"
                                className="text-error"
                                onClick={() => field.removeValue(index)}
                                aria-label={t(
                                  "assignments.autograder.removeTest",
                                  { number: index + 1 },
                                )}
                              >
                                <TrashIcon
                                  aria-hidden="true"
                                  className="size-4"
                                />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ),
                    )
                  )}
                </tbody>
              </TableShell>
            </Collapse>

            {editor && (
              <AutogradingTestModal
                // Remount per open so the local draft re-initializes from the
                // freshly opened baseline.
                key={`${editor.mode}-${editor.index}`}
                editor={editor}
                dialogRef={dialogRef}
                otherNames={otherNames(field.state.value, editor)}
                onCancel={closeEditor}
                onCommit={commitEditor}
              />
            )}
          </>
        )}
      </form.Field>
    </div>
  )
}

export default AutogradingTestsPane
