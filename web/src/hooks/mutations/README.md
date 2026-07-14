# hooks/mutations

The write-side boundary: one named hook per GitHub write operation. Adding a
write? Put it here, not in a page or `hooks/` root.

## The split (TanStack "Mastering Mutations")

Divide each mutation's side effects by whether they must run regardless of the
component's fate:

- **Hook `onSuccess`/`onError` — data-consistency that must ALWAYS run:** cache
  invalidation, optimistic cache reconcile, domain follow-ups. These fire even
  if the component unmounted mid-flight (react-query runs the hook-level
  callbacks unconditionally).
- **Call-site `mutate(vars, { onSuccess, onError })` — UI that should SKIP on
  unmount:** toasts, navigation, `form.reset`, component-state resets. These
  are skipped when the component is gone, which is the point — a `setState` on
  an unmounted component is the bug the split removes.

Put an effect on the wrong side and it either fires detached (UI in the hook) or
silently drops (invalidation at the call site). When unsure, ask "if the user
navigated away the instant this resolved, must this still happen?" — yes → hook,
no → call site.

## Copy an exemplar

- `useSyncRoster` — invalidate-only (the common shape).
- `useEnrollOrInviteStudent` — optimistic seed-and-reconcile with a
  data-consistency `onEnrolled` callback in the hook.
- `useExecuteTeardown` — owns invalidation on success AND rate-limit error, yet
  still re-throws so the caller's `ConfirmModal` shows the failure inline.

Hooks stay `t()`-free: a caller passes pre-translated strings via a `messages`
bag. The boundary is a convention, not yet lint-enforced (P7 earmarks
`eslint-plugin-boundaries`).
