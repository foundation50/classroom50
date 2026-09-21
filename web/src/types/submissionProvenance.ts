// Why a `submit/*` release is not the autograde workflow's own (see
// releaseProvenanceProblem in github-core). `recorded` is the collector's
// stored reason (`provenance_warning` on a scores-v1 submission record), shown
// as data. `author` / `uploader` are the live view's own judgment of a release
// scores.json hasn't seen yet; `login` is null when GitHub returned no account.
export type SubmissionProvenance =
  | { kind: "author"; login: string | null }
  | { kind: "uploader"; login: string | null }
  | { kind: "recorded"; reason: string }
