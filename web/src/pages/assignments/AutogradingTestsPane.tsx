import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { Pencil, Trash } from "lucide-react"
import type { AssignmentForm } from "./assignmentFormModel"

import { Badge, Button, Card, Input, Select, Textarea } from "@/components/ui"
import type { AssignmentTestDraft } from "@/util/assignmentTests"
import { emptyTestDraft, validateTestDraft } from "@/util/assignmentTests"
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

const FieldError = ({ error, id }: { error?: string; id?: string }) =>
  error ? (
    <p id={id} className="text-error text-sm mt-1" role="alert">
      {error}
    </p>
  ) : null

// Draft fields that can carry a validation error; stale errors are cleared on
// each re-validation.
const VALIDATED_FIELDS = [
  "name",
  "run",
  "points",
  "timeout",
  "input",
  "inputFile",
  "expected",
  "expectedFile",
  "exitCode",
] as const

type AutogradingTestModalProps = {
  form: AssignmentForm
  dialogRef: React.RefObject<HTMLDialogElement | null>
  index: number | null
  onClose: () => void
}
const AutogradingTestModal = ({
  form,
  dialogRef,
  index,
  onClose,
}: AutogradingTestModalProps) => {
  const { t } = useTranslation()
  const titleId = useId()
  if (index === null) return null

  // Validate this test now (form-level validator only runs on page submit) and
  // surface per-field errors. Returns valid?; "Done" waits until valid.
  const validateAndShowErrors = () => {
    const drafts: AssignmentTestDraft[] = form.state.values.tests
    const otherNames = drafts
      .filter((_, i) => i !== index)
      .map((d) => d.name.trim())
    const errors = validateTestDraft(drafts[index], otherNames)

    for (const fieldName of VALIDATED_FIELDS) {
      const message = errors[fieldName]
      const key = `tests[${index}].${fieldName}` as Parameters<
        typeof form.getFieldMeta
      >[0]
      // Fields that never mounted (e.g. exit code on an io test, or unbuilt
      // fixture-file inputs) have no meta and nowhere to show an error.
      if (!form.getFieldMeta(key)) continue
      form.setFieldMeta(key, (meta) => ({
        ...meta,
        errorMap: { ...meta.errorMap, onSubmit: message },
      }))
    }

    return Object.keys(errors).length === 0
  }

  const handleDone = () => {
    if (validateAndShowErrors()) onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={titleId}
      onClose={onClose}
      onKeyDown={(e) => {
        // Enter inside a modal input would implicitly submit the surrounding
        // create-assignment form (this dialog renders inside it). Repurpose as
        // "Done"; textareas keep Enter for newlines.
        if (
          e.key === "Enter" &&
          e.target instanceof HTMLElement &&
          e.target.tagName !== "TEXTAREA" &&
          e.target.tagName !== "BUTTON"
        ) {
          e.preventDefault()
          handleDone()
        }
      }}
    >
      <div className="modal-box max-w-3xl max-h-[90vh]">
        <div className="mb-6">
          <h3 id={titleId} className="text-lg font-bold">
            {t("assignments.autograder.editTest", { number: index + 1 })}
          </h3>
          <p className="text-sm opacity-70">
            {t("assignments.autograder.editTestHint")}
          </p>
        </div>

        <div className="space-y-5">
          <form.Field name={`tests[${index}].name`}>
            {(field) => (
              <div>
                <label htmlFor={field.name} className="label font-bold">
                  {t("assignments.autograder.testName")}
                </label>
                <Input
                  id={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder={t("assignments.autograder.testNamePlaceholder")}
                  invalid={field.state.meta.errors.length > 0}
                  aria-describedby={
                    field.state.meta.errors.length > 0
                      ? `${field.name}-error`
                      : undefined
                  }
                />
                <FieldError
                  error={field.state.meta.errors[0]}
                  id={`${field.name}-error`}
                />
              </div>
            )}
          </form.Field>

          <form.Field name={`tests[${index}].type`}>
            {(field) => (
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
                      name={`tests-${index}-type`}
                      aria-label={t(option.labelKey)}
                      checked={field.state.value === option.value}
                      onChange={() => field.handleChange(option.value)}
                    />
                  ))}
                </div>
                <p className="label text-sm pt-1">
                  {(() => {
                    const hintKey = TYPE_OPTIONS.find(
                      (o) => o.value === field.state.value,
                    )?.hintKey
                    return hintKey ? t(hintKey) : null
                  })()}
                </p>
              </fieldset>
            )}
          </form.Field>

          <form.Field name={`tests[${index}].setup`}>
            {(field) => (
              <div>
                <label htmlFor={field.name} className="label font-bold">
                  {t("assignments.autograder.setupCommand")}
                </label>
                <Input
                  id={field.name}
                  className="font-mono"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder={t(
                    "assignments.autograder.setupCommandPlaceholder",
                  )}
                />
              </div>
            )}
          </form.Field>

          <form.Field name={`tests[${index}].run`}>
            {(field) => (
              <div>
                <label htmlFor={field.name} className="label font-bold">
                  {t("assignments.autograder.runCommand")}
                </label>
                <Input
                  id={field.name}
                  className="font-mono"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder={t(
                    "assignments.autograder.runCommandPlaceholder",
                  )}
                  invalid={field.state.meta.errors.length > 0}
                  aria-describedby={
                    field.state.meta.errors.length > 0
                      ? `${field.name}-error`
                      : undefined
                  }
                />
                <FieldError
                  error={field.state.meta.errors[0]}
                  id={`${field.name}-error`}
                />
              </div>
            )}
          </form.Field>

          <form.Subscribe selector={(state) => state.values.tests[index]?.type}>
            {(typeValue) => (
              <>
                {typeValue === "io" && (
                  <>
                    <form.Field name={`tests[${index}].input`}>
                      {(field) => (
                        <div>
                          <label
                            htmlFor={field.name}
                            className="label font-bold"
                          >
                            {t("assignments.autograder.input")}
                          </label>
                          <Textarea
                            id={field.name}
                            className="font-mono"
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                            placeholder={t(
                              "assignments.autograder.inputPlaceholder",
                            )}
                            rows={3}
                          />
                        </div>
                      )}
                    </form.Field>

                    <form.Field name={`tests[${index}].expected`}>
                      {(field) => (
                        <div>
                          <label
                            htmlFor={field.name}
                            className="label font-bold"
                          >
                            {t("assignments.autograder.expectedOutput")}
                          </label>
                          <Textarea
                            id={field.name}
                            className="font-mono"
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                            placeholder={t(
                              "assignments.autograder.expectedOutputPlaceholder",
                            )}
                            rows={5}
                            invalid={field.state.meta.errors.length > 0}
                            aria-describedby={
                              field.state.meta.errors.length > 0
                                ? `${field.name}-error`
                                : undefined
                            }
                          />
                          <FieldError
                            error={field.state.meta.errors[0]}
                            id={`${field.name}-error`}
                          />
                        </div>
                      )}
                    </form.Field>

                    <form.Field name={`tests[${index}].comparison`}>
                      {(field) => (
                        <div>
                          <label
                            htmlFor={field.name}
                            className="label font-bold"
                          >
                            {t("assignments.autograder.comparison")}
                          </label>
                          <Select
                            id={field.name}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) =>
                              field.handleChange(
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
                        </div>
                      )}
                    </form.Field>
                  </>
                )}

                {typeValue === "run" && (
                  <form.Field name={`tests[${index}].exitCode`}>
                    {(field) => (
                      <div className="flex flex-col">
                        <label htmlFor={field.name} className="label font-bold">
                          {t("assignments.autograder.exitCode")}
                        </label>
                        <Input
                          id={field.name}
                          className="w-32"
                          type="number"
                          min={0}
                          max={255}
                          step={1}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) =>
                            field.handleChange(
                              e.target.value === ""
                                ? ""
                                : e.target.valueAsNumber,
                            )
                          }
                          placeholder="0"
                          invalid={field.state.meta.errors.length > 0}
                          aria-describedby={
                            field.state.meta.errors.length > 0
                              ? `${field.name}-error`
                              : undefined
                          }
                        />
                        <p className="label text-sm pt-1">
                          {t("assignments.autograder.exitCodeHint")}
                        </p>
                        <FieldError
                          error={field.state.meta.errors[0]}
                          id={`${field.name}-error`}
                        />
                      </div>
                    )}
                  </form.Field>
                )}

                {typeValue === "python" && (
                  <p className="rounded-box border border-dashed p-3 text-sm opacity-70">
                    {t("assignments.autograder.pythonNote_prefix")}{" "}
                    <code>python3 -m pytest -q</code>
                    {t("assignments.autograder.pythonNote_suffix")}
                  </p>
                )}
              </>
            )}
          </form.Subscribe>

          <div className="flex gap-8">
            <form.Field name={`tests[${index}].timeout`}>
              {(field) => (
                <div className="flex flex-col">
                  <label htmlFor={field.name} className="label font-bold">
                    {t("assignments.autograder.timeout")}
                  </label>
                  <Input
                    id={field.name}
                    className="w-32"
                    type="number"
                    min={0}
                    max={600}
                    step={1}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) =>
                      field.handleChange(
                        e.target.value === "" ? 0 : e.target.valueAsNumber,
                      )
                    }
                    invalid={field.state.meta.errors.length > 0}
                    aria-describedby={
                      field.state.meta.errors.length > 0
                        ? `${field.name}-error`
                        : undefined
                    }
                  />
                  <p className="label text-sm pt-1">
                    {t("assignments.autograder.timeoutHint")}
                  </p>
                  <FieldError
                    error={field.state.meta.errors[0]}
                    id={`${field.name}-error`}
                  />
                </div>
              )}
            </form.Field>

            <form.Field name={`tests[${index}].points`}>
              {(field) => (
                <div className="flex flex-col">
                  <label htmlFor={field.name} className="label font-bold">
                    {t("assignments.autograder.points")}
                  </label>
                  <Input
                    id={field.name}
                    className="w-32"
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) =>
                      field.handleChange(
                        e.target.value === "" ? 0 : e.target.valueAsNumber,
                      )
                    }
                    invalid={field.state.meta.errors.length > 0}
                    aria-describedby={
                      field.state.meta.errors.length > 0
                        ? `${field.name}-error`
                        : undefined
                    }
                  />
                  <FieldError
                    error={field.state.meta.errors[0]}
                    id={`${field.name}-error`}
                  />
                </div>
              )}
            </form.Field>
          </div>
        </div>

        <div className="modal-action">
          <Button variant="primary" onClick={handleDone}>
            {t("assignments.autograder.done")}
          </Button>
        </div>
      </div>
      <div className="modal-backdrop">
        <button type="button" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
    </dialog>
  )
}

const typeBadge = (type: AssignmentTestDraft["type"], t: TFunction) => {
  const labelKey = TYPE_OPTIONS.find((o) => o.value === type)?.labelKey
  return labelKey ? t(labelKey) : type
}

const AutogradingTestsPane = ({ form }: { form: AssignmentForm }) => {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)

  useEffect(() => {
    if (editingIndex === null) return

    const dialog = dialogRef.current
    if (!dialog || dialog.open) return

    dialog.showModal()
  }, [editingIndex])

  const openEditor = (index: number) => {
    setEditingIndex(index)
  }

  const closeEditor = () => {
    const dialog = dialogRef.current
    if (dialog?.open) dialog.close()
    setEditingIndex(null)
  }

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
                <Button
                  variant="outline"
                  onClick={() => {
                    const newIndex = field.state.value.length
                    field.pushValue(emptyTestDraft())
                    openEditor(newIndex)
                  }}
                >
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
                          <div className="max-w-xs">
                            <pre className="max-w-[12rem] truncate rounded bg-base-200 p-2 text-xs">
                              {test.run || "-"}
                            </pre>
                          </div>
                        </td>

                        <td>
                          <Badge tone="primary">{test.points}</Badge>
                        </td>

                        <td>
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditor(index)}
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

            <AutogradingTestModal
              form={form}
              dialogRef={dialogRef}
              index={editingIndex}
              onClose={closeEditor}
            />
          </Card.Body>
        )}
      </form.Field>
    </Card>
  )
}

export default AutogradingTestsPane
