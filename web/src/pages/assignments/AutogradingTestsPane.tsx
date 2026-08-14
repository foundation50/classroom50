import { useEffect, useId, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { Pencil, Trash } from "lucide-react"
import type { AssignmentForm } from "./assignmentFormModel"

import {
  Badge,
  Button,
  Card,
  Input,
  Modal,
  Select,
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

const FieldError = ({ error, id }: { error?: string; id?: string }) =>
  error ? (
    <p id={id} className="text-error text-sm mt-1" role="alert">
      {error}
    </p>
  ) : null

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
  const titleId = useId()
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
      aria-labelledby={titleId}
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
      <div className="mb-6">
        <h3 id={titleId} className="text-lg font-bold">
          {t("assignments.autograder.editTest", { number: editor.index + 1 })}
        </h3>
        <p className="text-sm opacity-70">
          {t("assignments.autograder.editTestHint")}
        </p>
      </div>

      <div className="space-y-5">
        <div>
          <label htmlFor={field("name")} className="label font-bold">
            {t("assignments.autograder.testName")}
          </label>
          <Input
            id={field("name")}
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={t("assignments.autograder.testNamePlaceholder")}
            invalid={!!errors.name}
            aria-describedby={
              errors.name ? `${field("name")}-error` : undefined
            }
          />
          <FieldError error={errors.name} id={`${field("name")}-error`} />
        </div>

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

        <div>
          <label htmlFor={field("setup")} className="label font-bold">
            {t("assignments.autograder.setupCommand")}
          </label>
          <Input
            id={field("setup")}
            className="font-mono"
            value={draft.setup}
            onChange={(e) => set("setup", e.target.value)}
            placeholder={t("assignments.autograder.setupCommandPlaceholder")}
          />
        </div>

        <div>
          <label htmlFor={field("run")} className="label font-bold">
            {t("assignments.autograder.runCommand")}
          </label>
          <Input
            id={field("run")}
            className="font-mono"
            value={draft.run}
            onChange={(e) => set("run", e.target.value)}
            placeholder={t("assignments.autograder.runCommandPlaceholder")}
            invalid={!!errors.run}
            aria-describedby={errors.run ? `${field("run")}-error` : undefined}
          />
          <FieldError error={errors.run} id={`${field("run")}-error`} />
        </div>

        {draft.type === "io" && (
          <>
            <div>
              <label htmlFor={field("input")} className="label font-bold">
                {t("assignments.autograder.input")}
              </label>
              <Textarea
                id={field("input")}
                className="font-mono"
                value={draft.input}
                onChange={(e) => set("input", e.target.value)}
                placeholder={t("assignments.autograder.inputPlaceholder")}
                rows={3}
              />
            </div>

            <div>
              <label htmlFor={field("expected")} className="label font-bold">
                {t("assignments.autograder.expectedOutput")}
              </label>
              <Textarea
                id={field("expected")}
                className="font-mono"
                value={draft.expected}
                onChange={(e) => set("expected", e.target.value)}
                placeholder={t(
                  "assignments.autograder.expectedOutputPlaceholder",
                )}
                rows={5}
                invalid={!!errors.expected}
                aria-describedby={
                  errors.expected ? `${field("expected")}-error` : undefined
                }
              />
              <FieldError
                error={errors.expected}
                id={`${field("expected")}-error`}
              />
            </div>

            <div>
              <label htmlFor={field("comparison")} className="label font-bold">
                {t("assignments.autograder.comparison")}
              </label>
              <Select
                id={field("comparison")}
                value={draft.comparison}
                onChange={(e) =>
                  set("comparison", e.target.value as AssignmentTestComparison)
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
            </div>
          </>
        )}

        {draft.type === "run" && (
          <div className="flex flex-col">
            <label htmlFor={field("exitCode")} className="label font-bold">
              {t("assignments.autograder.exitCode")}
            </label>
            <Input
              id={field("exitCode")}
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
              invalid={!!errors.exitCode}
              aria-describedby={
                errors.exitCode ? `${field("exitCode")}-error` : undefined
              }
            />
            <p className="text-sm pt-1 text-base-content/70">
              {t("assignments.autograder.exitCodeHint")}
            </p>
            <FieldError
              error={errors.exitCode}
              id={`${field("exitCode")}-error`}
            />
          </div>
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
          <div className="flex flex-col">
            <label htmlFor={field("timeout")} className="label font-bold">
              {t("assignments.autograder.timeout")}
            </label>
            <Input
              id={field("timeout")}
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
              invalid={!!errors.timeout}
              aria-describedby={
                errors.timeout ? `${field("timeout")}-error` : undefined
              }
            />
            <p className="text-sm pt-1 text-base-content/70">
              {t("assignments.autograder.timeoutHint")}
            </p>
            <FieldError
              error={errors.timeout}
              id={`${field("timeout")}-error`}
            />
          </div>

          <div className="flex flex-col">
            <label htmlFor={field("points")} className="label font-bold">
              {t("assignments.autograder.points")}
            </label>
            <Input
              id={field("points")}
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
              invalid={!!errors.points}
              aria-describedby={
                errors.points ? `${field("points")}-error` : undefined
              }
            />
            <FieldError error={errors.points} id={`${field("points")}-error`} />
          </div>
        </div>
      </div>

      <div className="modal-action">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" onClick={handleCommit} disabled={!dirty}>
          {editor.mode === "new"
            ? t("assignments.autograder.addTest")
            : t("common.save")}
        </Button>
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
    closeEditor()
  }

  const otherNames = (tests: AssignmentTestDraft[], active: EditorState) =>
    tests
      .filter((_, i) => active.mode === "new" || i !== active.index)
      .map((d) => d.name.trim())
  return (
    <Card bordered={false}>
      <form.Field name="tests" mode="array">
        {(field) => (
          <Card.Body>
            <div className="flex justify-between mb-6">
              <div>
                <h3 className="text-lg font-bold">
                  {t("assignments.autograder.heading")}
                </h3>
                <h3 className="text-md opacity-70">
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
                </h3>
              </div>
              <div>
                <Button variant="outline" onClick={openNewEditor}>
                  {t("assignments.autograder.addTest")}
                </Button>
              </div>
            </div>
            <table className="table">
              <caption className="sr-only">
                {t("assignments.autograder.heading")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("assignments.autograder.testName")}</th>
                  <th scope="col">{t("assignments.autograder.colType")}</th>
                  <th scope="col">{t("assignments.autograder.runCommand")}</th>
                  <th scope="col">{t("assignments.autograder.points")}</th>
                  <th scope="col" className="w-28">
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
                      <div className="rounded-box border border-dashed p-4 text-sm opacity-70">
                        {t("assignments.autograder.empty")}
                      </div>
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

                        <td>
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditEditor(index)}
                              aria-label={t("assignments.autograder.editTest", {
                                number: index + 1,
                              })}
                            >
                              <Pencil aria-hidden="true" size={16} />
                            </Button>

                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-error"
                              onClick={() => field.removeValue(index)}
                              aria-label={t(
                                "assignments.autograder.removeTest",
                                { number: index + 1 },
                              )}
                            >
                              <Trash aria-hidden="true" size={16} />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ),
                  )
                )}
              </tbody>
            </table>

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
          </Card.Body>
        )}
      </form.Field>
    </Card>
  )
}

export default AutogradingTestsPane
