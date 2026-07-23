import { Pencil } from "lucide-react"
import { useId, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { useTranslation } from "react-i18next"

import { Button, FormField, Input, Modal, Textarea } from "@/components/ui"
import { GitHubLink } from "@/components/GitHubLink"
import { useToast } from "@/context/notifications/NotificationProvider"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import { useUpdateOrgProfile } from "@/hooks/mutations/useUpdateOrgProfile"
import type { OrgProfileUpdate } from "@/github-core/mutations"
import { isOwnerGitHubOrgRole } from "@/authz"
import type { Classroom50OrgSummary } from "@/github-core/queries"
import { githubOrgSettingsUrl } from "@/util/orgUrl"
import { normalizeWebsiteUrl, safeHttpUrl } from "@/util/url"

type ProfileFormValues = {
  name: string
  description: string
  blog: string
  location: string
  email: string
  company: string
}

// A definition-list row; renders nothing when the value is empty so the view
// shows only fields that are actually set (all fields are editable in edit mode).
// `value` may be a string or a node (e.g. a mailto/website link).
function InfoRow({ label, value }: { label: string; value?: React.ReactNode }) {
  if (!value) return null
  return (
    <div>
      <dt className="text-xs font-medium text-base-content/50">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{value}</dd>
    </div>
  )
}

// The org's public profile with owner-only inline editing, opened from the
// home-card kebab. Reads GET /orgs/{login} from the shared cache (no extra
// request — the card already fetches it) and writes via PATCH /orgs/{org}.
// Avatar is read-only: GitHub's REST API can't set it (web-only).
function OrgDetailsModal({
  summary,
  open,
  onClose,
}: {
  summary: Classroom50OrgSummary
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { notify } = useToast()
  const titleId = useId()
  const { org, membership } = summary
  const [editing, setEditing] = useState(false)

  // Fetch on the login unconditionally (not gated on `open`): same
  // ["github","orgs",login] key the card already fetches, so React Query
  // dedupes it, and the data stays stable through the close animation.
  const { data: details } = useGetOrgPlanDetails(org.login)
  const updateProfile = useUpdateOrgProfile(org.login)

  const isOwner = isOwnerGitHubOrgRole(membership.role)
  const heading = details?.name ?? org.login
  const websiteHref = safeHttpUrl(details?.blog)

  const currentValues = (): ProfileFormValues => ({
    name: details?.name ?? "",
    description: details?.description ?? "",
    blog: details?.blog ?? "",
    location: details?.location ?? "",
    email: details?.email ?? "",
    company: details?.company ?? "",
  })

  const form = useForm({
    defaultValues: currentValues(),
    onSubmit: async ({ value }) => {
      // Relax website input: accept a bare host (e.g. "classroom50.org") and
      // default it to https:// via the built-in URL parser. A blank value clears
      // the field; an unsafe value (e.g. a javascript: scheme) is dropped from
      // the payload rather than sent raw, so the sanitizer isn't defeated.
      const trimmedBlog = value.blog.trim()
      const normalizedBlog = trimmedBlog ? normalizeWebsiteUrl(trimmedBlog) : ""
      const update: OrgProfileUpdate = { ...value }
      if (normalizedBlog === undefined) delete update.blog
      else update.blog = normalizedBlog
      try {
        await updateProfile.mutateAsync(update)
        notify({
          tone: "success",
          durationMs: 4000,
          message: t("orgs.detailsModal.saved", { org: heading }),
        })
        setEditing(false)
      } catch (err) {
        notify({
          tone: "error",
          message: t("orgs.detailsModal.saveError", {
            error: err instanceof Error ? err.message : "",
          }),
        })
      }
    },
  })

  const startEditing = () => {
    // Reset to the latest fetched values — details may have loaded after the
    // form initialized with empty defaults.
    form.reset(currentValues())
    setEditing(true)
  }

  const stopEditing = () => {
    form.reset(currentValues())
    setEditing(false)
  }

  const handleClose = () => {
    setEditing(false)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="2xl"
      aria-labelledby={titleId}
    >
      {/* Header: avatar + name, with an owner-only pencil badge on the avatar
          in edit mode (links to GitHub settings — the REST API can't set an org
          avatar). pe-8 keeps the row clear of the Modal's close X. */}
      <div className="flex items-center gap-3 pe-8">
        <div className="relative shrink-0">
          <img
            src={org.avatar_url}
            alt=""
            className="size-12 rounded-xl border border-base-300"
          />
          {isOwner && editing && (
            <a
              href={githubOrgSettingsUrl(org.login)}
              target="_blank"
              rel="noreferrer"
              title={t("orgs.detailsModal.editOnGitHub")}
              aria-label={t("orgs.detailsModal.editOnGitHub")}
              className="absolute -bottom-1.5 -start-1.5 flex size-5 items-center justify-center rounded-full border border-base-300 bg-base-100 text-base-content/70 shadow-sm hover:text-primary"
            >
              <Pencil aria-hidden="true" className="size-3" />
            </a>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="truncate text-lg font-bold">
            {heading}
          </h3>
          <p className="truncate font-mono text-xs text-base-content/50">
            {org.login}
          </p>
        </div>
      </div>

      {editing ? (
        <form
          className="mt-5 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void form.handleSubmit()
          }}
        >
          <form.Field name="name">
            {(field) => (
              <FormField
                label={t("orgs.detailsModal.displayName")}
                htmlFor={field.name}
              >
                {({ id, describedById }) => (
                  <Input
                    id={id}
                    aria-describedby={describedById}
                    inputSize="sm"
                    value={field.state.value}
                    placeholder={t("orgs.detailsModal.displayNamePlaceholder")}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                  />
                )}
              </FormField>
            )}
          </form.Field>

          <form.Field name="description">
            {(field) => (
              <FormField
                label={t("orgs.detailsModal.description")}
                htmlFor={field.name}
              >
                {({ id, describedById }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedById}
                    rows={2}
                    value={field.state.value}
                    placeholder={t("orgs.detailsModal.descriptionPlaceholder")}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                  />
                )}
              </FormField>
            )}
          </form.Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <form.Field name="blog">
              {(field) => (
                <FormField
                  label={t("orgs.detailsModal.website")}
                  htmlFor={field.name}
                >
                  {({ id, describedById }) => (
                    <Input
                      id={id}
                      aria-describedby={describedById}
                      inputSize="sm"
                      type="text"
                      inputMode="url"
                      placeholder={t("orgs.detailsModal.websitePlaceholder")}
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </FormField>
              )}
            </form.Field>

            <form.Field name="location">
              {(field) => (
                <FormField
                  label={t("orgs.detailsModal.location")}
                  htmlFor={field.name}
                >
                  {({ id, describedById }) => (
                    <Input
                      id={id}
                      aria-describedby={describedById}
                      inputSize="sm"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </FormField>
              )}
            </form.Field>

            <form.Field name="email">
              {(field) => (
                <FormField
                  label={t("orgs.detailsModal.email")}
                  htmlFor={field.name}
                >
                  {({ id, describedById }) => (
                    <Input
                      id={id}
                      aria-describedby={describedById}
                      inputSize="sm"
                      type="email"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </FormField>
              )}
            </form.Field>

            <form.Field name="company">
              {(field) => (
                <FormField
                  label={t("orgs.detailsModal.school")}
                  htmlFor={field.name}
                >
                  {({ id, describedById }) => (
                    <Input
                      id={id}
                      aria-describedby={describedById}
                      inputSize="sm"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </FormField>
              )}
            </form.Field>
          </div>

          <div className="modal-action">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={stopEditing}
              disabled={updateProfile.isPending}
            >
              {t("orgs.detailsModal.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={updateProfile.isPending}
              loadingLabel={t("orgs.detailsModal.saving")}
            >
              {t("orgs.detailsModal.save")}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="mt-5 flex flex-col gap-3">
            {/* Description spans full width; Website + Email follow as a pair. */}
            <InfoRow
              label={t("orgs.detailsModal.description")}
              value={details?.description}
            />

            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <InfoRow
                label={t("orgs.detailsModal.website")}
                value={
                  websiteHref ? (
                    <a
                      href={websiteHref}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      {details?.blog}
                    </a>
                  ) : (
                    details?.blog
                  )
                }
              />
              <InfoRow
                label={t("orgs.detailsModal.email")}
                value={
                  details?.email ? (
                    <a
                      href={`mailto:${encodeURIComponent(details.email)}`}
                      className="text-primary hover:underline"
                    >
                      {details.email}
                    </a>
                  ) : null
                }
              />
              <InfoRow
                label={t("orgs.detailsModal.location")}
                value={details?.location}
              />
              <InfoRow
                label={t("orgs.detailsModal.school")}
                value={details?.company}
              />
              {/* Plan and org ID are owner-facing details. Plan is only
                  returned to owners anyway; org ID is hidden from members to
                  keep the member view focused on the public profile. */}
              {isOwner && (
                <InfoRow
                  label={t("orgs.detailsModal.plan")}
                  value={details?.plan?.name}
                />
              )}
              {isOwner && (
                <InfoRow
                  label={t("orgs.detailsModal.orgId")}
                  value={String(org.id)}
                />
              )}
              <InfoRow
                label={t("orgs.detailsModal.role")}
                value={
                  isOwner
                    ? t("orgs.detailsModal.roleAdmin")
                    : t("orgs.detailsModal.roleMember")
                }
              />
            </dl>
          </div>

          <div className="modal-action items-center justify-between">
            {isOwner ? (
              <GitHubLink
                href={githubOrgSettingsUrl(org.login)}
                label={t("orgs.detailsModal.manageOnGitHub")}
              />
            ) : (
              // Keep the buttons right-aligned when the manage link is hidden.
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={handleClose}>
                {t("orgs.detailsModal.close")}
              </Button>
              {isOwner && (
                <Button variant="primary" size="sm" onClick={startEditing}>
                  <Pencil aria-hidden="true" className="size-4" />
                  {t("orgs.detailsModal.edit")}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}

export default OrgDetailsModal
