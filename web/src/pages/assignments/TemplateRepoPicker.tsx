import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Lock, Search } from "lucide-react"

import { Combobox, MonoLtr } from "@/components/ui"
import { GitHubAPIError } from "@/github-core/errors"
import type { TemplateRepoSearchItem } from "@/github-core/queries"
import { useSearchOrgTemplateRepos } from "@/hooks/useSearchOrgTemplateRepos"
import { formatRelativeToNow } from "@/util/formatDate"
import { normalizeOnBlur, type StringField } from "./formFieldHelpers"

// The template field's input: a combobox over the org's template repos, backed
// by server-side search so an org with tens of thousands of repos costs one
// request per settled keystroke.
//
// Typing and pasting are never gated by the picker — the field stays a plain
// text input that happens to offer suggestions, because a teacher may reference
// a template in another org (or one the search index hasn't caught up with yet).
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

  const search = useSearchOrgTemplateRepos({
    org,
    query: field.state.value,
    enabled: open,
  })

  const items = search.data?.items ?? []
  const totalCount = search.data?.totalCount ?? 0
  const throttled =
    search.error instanceof GitHubAPIError && search.error.isRateLimited

  const select = (item: TemplateRepoSearchItem) => {
    field.handleChange(item.fullName)
  }

  // One line above the options, and only when it says something the list
  // doesn't: still searching, throttled, or a partial index answer.
  const status = search.isSearching
    ? t("assignments.template.search.searching")
    : throttled
      ? t("assignments.template.search.throttled")
      : search.isError
        ? t("assignments.template.search.unavailable")
        : search.data?.incomplete
          ? t("assignments.template.search.incomplete")
          : null

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
        search.isSearching
          ? null
          : throttled || search.isError
            ? t("assignments.template.search.typeInstead")
            : field.state.value.trim()
              ? t("assignments.template.search.noMatches", {
                  query: field.state.value.trim(),
                })
              : t("assignments.template.search.noTemplates")
      }
      footer={
        // Only meaningful when the org has more matches than one page shows —
        // the case the whole search design exists for.
        totalCount > items.length
          ? t("assignments.template.search.narrow", {
              shown: items.length,
              total: totalCount,
            })
          : null
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
