// Why a `submit/*` release is not the autograde workflow's own. The three
// readers (collector, `gh teacher download`, web) judge this from the release's
// author and `result.json` uploader; the release is still counted, so the mark
// travels beside the score for the teacher to weigh.
//
// `recorded` is the collector's stored reason (`provenance_warning` on a
// scores-v1 submission record), shown as data. `author` / `uploader` are the
// live view's own judgment of a release scores.json hasn't seen yet; `login` is
// null when GitHub returned no account for it.
export type SubmissionProvenance =
  | { kind: "author"; login: string | null }
  | { kind: "uploader"; login: string | null }
  | { kind: "recorded"; reason: string }
