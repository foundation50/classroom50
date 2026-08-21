import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Lock, Search } from "lucide-react"

import { Combobox, MonoLtr } from "@/components/ui"
import type { TemplateRepoItem } from "@/github-core/queries"
import { useOrgTemplateRepos } from "@/hooks/useOrgTemplateRepos"
import { formatRelativeToNow } from "@/util/formatDate"
import { normalizeOnBlur, type StringField } from "./formFieldHelpers"

// The template field's input: a combobox over the org's template repositories.
//
// The list is loaded once and filtered in the browser, so typing is instant and
// costs no requests. GitHub's repo-search API would have been the natural fit
// but can't be called from a browser at all — it answers with a malformed
// `Access-Control-Allow-Origin: *;` and then 502s.
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
  labelledBy,
}: {
  field: StringField
  id: string
  describedById?: string
  org?: string
  placeholder: string
  labelledBy?: string
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const templates = useOrgTemplateRepos({
    org,
    query: field.state.value,
    enabled: open,
  })

  const { items, totalCount } = templates

  const select = (item: TemplateRepoItem) => {
    field.handleChange(item.fullName)
  }

  // One line above the options, and only when it says something the list itself
  // doesn't.
  const status = templates.isLoadingList
    ? t("assignments.template.search.loading")
    : templates.isError
      ? t("assignments.template.search.unavailable")
      : null

  const typed = field.state.value.trim()

  return (
    <Combobox
      id={id}
      name={field.name}
      labelledBy={labelledBy}
      aria-describedby={describedById}
      placeholder={placeholder}
      spellCheck={false}
      leadingIcon={
        <Search aria-hidden="true" className="size-4 shrink-0 opacity-60" />
      }
      value={field.state.value}
      onInputChange={(value) => field.handleChange(value)}
      onBlur={normalizeOnBlur(field)}
      open={open}
      onOpenChange={setOpen}
      items={items}
      getItemKey={(item) => item.fullName}
      getItemLabel={(item) => item.fullName}
      onSelect={select}
      status={status}
      emptyState={
        templates.isLoadingList
          ? null
          : templates.isError
            ? t("assignments.template.search.typeInstead")
            : typed
              ? t("assignments.template.search.noMatches", { query: typed })
              : t("assignments.template.search.noTemplates")
      }
      footer={
        // Two different facts, and only when true: how much of a typed filter's
        // haystack is hidden, and that we didn't list the entire org.
        totalCount > items.length || templates.truncated ? (
          <>
            {totalCount > items.length
              ? t("assignments.template.search.showing", {
                  shown: items.length,
                  total: totalCount,
                })
              : null}
            {templates.truncated ? (
              <span className="block">
                {t("assignments.template.search.truncated", {
                  scanned: templates.scanned,
                })}
              </span>
            ) : null}
          </>
        ) : null
      }
      renderItem={(item) => (
        <>
          <span className="flex items-center gap-1.5">
            <MonoLtr className="text-sm">{item.fullName}</MonoLtr>
            {item.private ? (
              <Lock
                aria-label={t("assignments.template.search.privateRepo")}
                className="size-3.5 shrink-0 text-base-content/50"
              />
            ) : null}
          </span>
          {item.description ? (
            <span className="line-clamp-1 text-xs text-base-content/60">
              {item.description}
            </span>
          ) : null}
          {item.updatedAt ? (
            <span className="text-xs text-base-content/45">
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
