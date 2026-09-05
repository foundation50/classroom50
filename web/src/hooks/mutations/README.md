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
- `useExecuteTeardown` — owns invalidation on success and on any abort that
  actually deleted something, yet still re-throws so the caller's `ConfirmModal`
  shows the failure inline.

Hooks stay `t()`-free: a caller passes pre-translated strings via a `messages`
bag. The boundary is a convention, not yet lint-enforced (P7 earmarks
`eslint-plugin-boundaries`).

## Hold the tab on multi-write chains

A hook whose `mutationFn` issues more than one GitHub write, or fans out over
many repos or students, declares `meta: { keepTabOpen: true }`. `KeepTabOpenGuard`
(mounted once in `main.tsx`) reads the flag off the mutation cache and asks the
browser to confirm before the tab closes while any such mutation is pending; the
hold survives the page unmounting because the cache, not the component, is the
signal. Closing mid-chain otherwise strands partial state: a repo with no marker
commit, a team without its roster row, a renamed manifest with half the repos
still on the old name.

Convergent background passes (`useSyncRoster`, `useBestEffortOwnerReconcile`)
are flagged too, plus `backgroundPass: true`. They are safe to re-run, but a
pass cut off mid-way still leaves a gap until the next open, so the close-tab
friction applies; and since the viewer didn't start them, `BackgroundPassTag`
shows a small "Syncing with GitHub…" tag at the top while one runs so the
prompt has a visible cause. The tag follows Primer's loading pattern: it waits
a full second before appearing, its live region is always mounted, and it
announces completion (or a best-effort pass that didn't finish).

Not flagged, on purpose:

- One write. A single PATCH, or one git-data commit (tree and commit objects
  are dangling until the ref moves), either lands or doesn't.
- A fan-out orchestrated by a component over single-write hooks (the bulk
  modals) or domain functions (the roster bars). Those call
  `useBeforeUnloadGuard(running)` themselves; see that hook.

## Deliberate exceptions

The boundary is **GitHub data writes** against the app's query cache. Two
`useMutation` clusters stay inline by design because they aren't that:

- **`auth/useGithubAuth.tsx`** (`exchangeWebCode` / `requestDeviceCode` /
  `fetchGithubUserWithScopes`) — login state-machine transitions, not cache
  writes. No invalidation/reconcile, one call site each inside the provider, and
  their `.isPending` feeds the provider's returned flags; extracting them would
  fragment the state machine.
- **`hooks/useGitHubOperation` / `hooks/useActionActivity`** — generic
  write-infra wrappers, not a specific operation.
