import { PlusIcon } from "@/components/ui/icons"

// Identity pieces shared by the group-membership editors (the manage and
// recover dialogs, the unassigned-students panel). Span-based blocks so the
// same markup renders inside a <div> row or a <label> host.

// Avatar for a roster member row: the GitHub avatar, else a fallback circle
// with the caller's initials (or first letter).
export function MemberAvatarCircle({
  avatarUrl,
  fallback,
}: {
  avatarUrl?: string
  fallback: string
}) {
  return avatarUrl ? (
    <img src={avatarUrl} alt="" className="size-8 shrink-0 rounded-full" />
  ) : (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-base-200 text-xs text-primary"
    >
      {fallback}
    </span>
  )
}

// Avatar slot for a pending "will be added" row.
export function PendingAddAvatar() {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-xs text-success"
    >
      <PlusIcon className="size-4" />
    </span>
  )
}

// The name + login lines of a member row: the roster full name with the login
// underneath, or just the login when the roster carries no name. `removed`
// paints the pending-removal state (struck through, error tint).
export function MemberNameLines({
  name,
  login,
  removed = false,
}: {
  name?: string
  login: string
  removed?: boolean
}) {
  return (
    <span className="min-w-0 flex-1">
      <span
        className={
          removed
            ? "block truncate text-sm font-medium text-error line-through opacity-70"
            : "block truncate text-sm font-medium"
        }
      >
        {name || login}
      </span>
      {name && (
        <span
          className={
            removed
              ? "block truncate text-xs text-error/70 line-through"
              : "block truncate text-xs text-base-content/70"
          }
        >
          {login}
        </span>
      )}
    </span>
  )
}
