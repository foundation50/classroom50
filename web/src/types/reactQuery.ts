// Per-mutation flags read app-wide off the mutation cache. Rationale and the
// list of what is (and isn't) flagged: hooks/mutations/README.md.
export type MutationMeta =
  | {
      // Losing the tab mid-run costs the user something: a chain of GitHub
      // writes strands partial state, or a long read (an archive download)
      // has to start over. KeepTabOpenGuard holds the tab.
      keepTabOpen?: boolean
      backgroundPass?: never
    }
  | {
      // A convergent pass the app started itself; BackgroundPassTag shows it.
      // Always a multi-write chain, so the tab hold is required with it.
      keepTabOpen: true
      backgroundPass: true
    }

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: MutationMeta
  }
}
