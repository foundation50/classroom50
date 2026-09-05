// Per-mutation flags read app-wide off the mutation cache (not a component's
// `isPending`, which dies with the component while the write keeps running).
export type MutationMeta = {
  // The mutationFn chains more than one GitHub write, or fans out over many
  // repos or students, so closing the tab mid-run strands partial state.
  // KeepTabOpenGuard asks the browser to confirm while one is pending. A single
  // write needs no flag: one PATCH, or one git-data commit (tree and commit
  // objects are invisible until the ref moves), either lands or doesn't.
  keepTabOpen?: boolean
  // The app started this write itself (a convergent reconcile on page entry),
  // so no button or spinner reflects it. BackgroundPassBar shows the blue top
  // bar while one is pending. Always paired with keepTabOpen.
  backgroundPass?: boolean
}

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: MutationMeta
  }
}
