import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { LockIcon, SearchIcon } from "@/components/ui/icons"

import { Combobox, MonoLtr } from "@/components/ui"
import type { TemplateRepoItem } from "@/github-core/queries"
import { useOrgTemplateRepos } from "@/hooks/useOrgTemplateRepos"
import { formatRelativeToNow } from "@/util/formatDate"
import { normalizeOnBlur, type StringField } from "./formFieldHelpers"

// The template field's input: a combobox over the org's template repositories.
//
// Typing and pasting are never gated by the picker: the field stays a plain text
// input that happens to offer suggestions, because a teacher may reference a
// template in another org, or one outside the pages we listed.
export const TemplateRepoPicker = ({
  field,
  id,
  describedById,
  org,
  placeholder,
  canonicalRef,
}: {
  field: StringField
  id: string
  describedById?: string
  org?: string
  placeholder: string
  // The canonical `{owner}/{repo}` for the current text once GitHub has
  // confirmed the repo exists, else null. Supplied by TemplateField, which owns
  // the verification query.
  canonicalRef?: string | null
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const edited = useRef(false)

  const templates = useOrgTemplateRepos({
    org,
    query: field.state.value,
    enabled: open,
  })

  const { items, totalCount } = templates
  const typed = field.state.value.trim()

  const select = (item: TemplateRepoItem) => {
    edited.current = true
    field.handleChange(item.fullName)
  }

  // Normalize to `{owner}/{repo}` once verification confirms the repo — never
  // mid-typing, which would fight the cursor, and never before the teacher has
  // touched the field, which would silently dirty an edit form on open.
  useEffect(() => {
    if (!edited.current || focused || !canonicalRef) return
    field.handleChange(canonicalRef)
  }, [focused, canonicalRef, field])

  const status = () => {
    if (templates.isLoadingList) return t("assignments.template.search.loading")
    if (templates.isError) return t("assignments.template.search.unavailable")
    return null
  }

  const emptyState = () => {
    if (templates.isLoadingList) return null
    if (templates.isError) return t("assignments.template.search.typeInstead")
    if (typed) {
      return t("assignments.template.search.noMatches", { query: typed })
    }
    return t("assignments.template.search.noTemplates")
  }

  // Each caveat only when it's true: how much of a typed filter's haystack is
  // hidden, that the whole org wasn't listed, and that GitHub never said which
  // repos are templates.
  const footerLines = [
    totalCount > items.length &&
      t("assignments.template.search.showing", {
        shown: items.length,
        total: totalCount,
      }),
    templates.truncated &&
      t("assignments.template.search.truncated", {
        scanned: templates.scanned,
      }),
    !templates.templateFlagPresent &&
      t("assignments.template.search.unfiltered"),
  ].filter((line): line is string => Boolean(line))

  return (
    <Combobox
      id={id}
      name={field.name}
      label={t("assignments.template.label")}
      aria-describedby={describedById}
      placeholder={placeholder}
      spellCheck={false}
      leadingIcon={
        <SearchIcon aria-hidden="true" className="size-4 shrink-0 opacity-60" />
      }
      value={field.state.value}
      onInputChange={(value) => {
        edited.current = true
        field.handleChange(value)
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        normalizeOnBlur(field)()
      }}
      open={open}
      onOpenChange={setOpen}
      items={items}
      getItemKey={(item) => item.fullName}
      getItemLabel={(item) => item.fullName}
      onSelect={select}
      status={status()}
      emptyState={emptyState()}
      footer={
        footerLines.length > 0
          ? footerLines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))
          : null
      }
      renderItem={(item) => (
        <>
          <span className="flex items-center gap-1.5">
            <MonoLtr className="text-sm">{item.fullName}</MonoLtr>
            {item.private ? (
              <LockIcon
                aria-label={t("assignments.template.search.privateRepo")}
                className="size-4 shrink-0 text-base-content/50"
              />
            ) : null}
          </span>
          {item.description ? (
            <span className="line-clamp-1 text-xs text-base-content/60">
              {item.description}
            </span>
          ) : null}
          {item.updatedAt ? (
            <span className="text-xs text-base-content/50">
              {t("assignments.template.search.updated", {
                when: formatRelativeToNow(new Date(item.updatedAt)),
              })}
            </span>
          ) : null}
        </>
      )}
    />
  )
}

export default TemplateRepoPicker
