// The default service-token name Classroom 50 suggests and stores. GitHub does
// not expose a fine-grained PAT's name via the API, so this is a label we
// prefill into the token-creation form (?name=) AND record ourselves in a repo
// variable for read-back. The user may edit it on GitHub or rename our stored
// copy later.
//
// Shape: `classroom50-token-<org-id>-<hash>` where <hash> is a random 4-char
// [a-z0-9]. The org id (stable, unlike the renamable slug) makes the token
// self-identifying in a multi-org teacher's PAT list; the hash disambiguates a
// regenerated token from a prior same-org one.

import { generateSecret } from "@/util/secret"

// GitHub rejects a fine-grained PAT name over 40 chars. The prefix is 18 chars
// ("classroom50-token-"), so with a 4-char hash and a hyphen the org id has 17
// chars of headroom — far beyond any real numeric id.
export const GITHUB_TOKEN_NAME_MAX = 40

const NAME_PREFIX = "classroom50-token-"
const HASH_LENGTH = 4

// A random 4-char [a-z0-9] suffix. Reuses the crypto random-string generator
// (same [a-z0-9] alphabet, rejection-sampled to avoid modulo bias); the name
// isn't a secret, so this is just anti-collision friction.
export function randomTokenHash(length: number = HASH_LENGTH): string {
  return generateSecret(length)
}

// Build the default token name for an org. `hash` is injectable for
// deterministic tests; it defaults to a fresh random suffix.
export function serviceTokenName(
  orgId: number | string,
  hash: string = randomTokenHash(),
): string {
  return `${NAME_PREFIX}${orgId}-${hash}`
}

// Module-load guard: the longest name we could generate (a generously wide
// numeric id plus the hash) must still fit GitHub's cap, so a future prefix or
// hash-length edit fails fast in dev/CI instead of shipping a rejected name.
const WORST_CASE_NAME = serviceTokenName(
  "9".repeat(15),
  "z".repeat(HASH_LENGTH),
)
if (WORST_CASE_NAME.length > GITHUB_TOKEN_NAME_MAX) {
  throw new Error(
    `serviceTokenName worst case "${WORST_CASE_NAME}" is ${WORST_CASE_NAME.length} chars; ` +
      `GitHub rejects PAT names longer than ${GITHUB_TOKEN_NAME_MAX}.`,
  )
}
