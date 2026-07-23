import { ExternalLink, Pencil } from "lucide-react"
import { useId, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { useTranslation } from "react-i18next"

import { Button, FormField, Input, Modal, Textarea } from "@/components/ui"
import GitHub from "@/assets/github.svg?react"
import { useToast } from "@/context/notifications/NotificationProvider"
import useGetOrgPlanDetails from "@/hooks/useGetOrgPlanDetails"
import { useUpdateOrgProfile } from "@/hooks/mutations/useUpdateOrgProfile"
import { isOwnerGitHubOrgRole } from "@/authz"
import type { Classroom50OrgSummary } from "@/github-core/queries"
import {
  githubOrgUrl,
  githubOrgPeopleUrl,
  githubOrgTeamsUrl,
  githubOrgSettingsUrl,
} from "@/util/orgUrl"

type ProfileFormValues = {
  name: string
  description: string
  blog: string
  location: string
  email: string
  company: string
}

// A definition-list row; renders "Not set" in muted text for empty values.
function InfoRow({ label, value }: { label: string; value?: string | null }) {
  const { t } = useTranslation()
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-base-content/50">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-sm">
        {value ? (
          value
        ) : (
          <span className="text-base-content/40">
            {t("orgs.detailsModal.notSet")}
          </span>
        )}
      </dd>
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
  const displayName = details?.name ?? undefined
  const heading = displayName ?? org.login

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
      try {
        await updateProfile.mutateAsync(value)
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

  const links: { label: string; href: string }[] = [
    { label: t("orgs.detailsModal.linkProfile"), href: org.html_url },
    { label: t("orgs.detailsModal.linkRepos"), href: githubOrgUrl(org.login) },
    {
      label: t("orgs.detailsModal.linkTeams"),
      href: githubOrgTeamsUrl(org.login),
    },
    {
      label: t("orgs.detailsModal.linkPeople"),
      href: githubOrgPeopleUrl(org.login),
    },
    ...(isOwner
      ? [
          {
            label: t("orgs.detailsModal.linkSettings"),
            href: githubOrgSettingsUrl(org.login),
          },
        ]
      : []),
  ]

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="lg"
      aria-labelledby={titleId}
    >
      {/* Header: avatar + name; avatar is read-only with a link out to GitHub. */}
      <div className="flex items-center gap-3 pe-8">
        <div className="flex flex-col items-center gap-1">
          <img
            src={org.avatar_url}
            alt=""
            className="size-12 shrink-0 rounded-xl border border-base-300"
          />
          {isOwner && (
            <a
              href={githubOrgSettingsUrl(org.login)}
              target="_blank"
              rel="noreferrer"
              title={t("orgs.detailsModal.avatarHint")}
              className="text-[10px] text-base-content/50 hover:text-primary"
            >
              {t("orgs.detailsModal.changeAvatar")}
            </a>
          )}
        </div>
        <div className="min-w-0">
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
                      type="url"
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
                  label={t("orgs.detailsModal.company")}
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
          <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <InfoRow
              label={t("orgs.detailsModal.description")}
              value={details?.description}
            />
            <InfoRow
              label={t("orgs.detailsModal.website")}
              value={details?.blog}
            />
            <InfoRow
              label={t("orgs.detailsModal.location")}
              value={details?.location}
            />
            <InfoRow
              label={t("orgs.detailsModal.email")}
              value={details?.email}
            />
            <InfoRow
              label={t("orgs.detailsModal.company")}
              value={details?.company}
            />
            {details?.plan?.name && (
              <InfoRow
                label={t("orgs.detailsModal.plan")}
                value={details.plan.name}
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

          <div className="mt-6">
            <p className="text-xs font-medium uppercase tracking-wide text-base-content/50">
              {t("orgs.detailsModal.linksHeading")}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {links.map((link) => (
                <Button
                  key={link.label}
                  as="a"
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  variant="outline"
                  size="sm"
                >
                  <GitHub aria-hidden="true" className="size-4" />
                  {link.label}
                  <ExternalLink aria-hidden="true" className="size-3" />
                </Button>
              ))}
            </div>
          </div>

          <div className="modal-action">
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
        </>
      )}
    </Modal>
  )
}

export default OrgDetailsModal
