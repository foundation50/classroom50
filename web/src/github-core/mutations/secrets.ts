import { createGitHubClient } from "../client"
import { GitHubAPIError } from "../errors"
import sodium from "libsodium-wrappers"
import { getErrorMessage } from "../errorMessage"
import { CONFIG_REPO } from "@/util/configRepo"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_GITHUB_SETUP } from "@/lib/logScopes"
import type { GitHubClient } from "../client"

const logSetup = logger.scope(LOG_SCOPE_GITHUB_SETUP)

export async function encryptSecret(publicKey: string, secret: string) {
  await sodium.ready

  const binkey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL)
  const binsec = sodium.from_string(secret)

  const encBytes = sodium.crypto_box_seal(binsec, binkey)

  return sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL)
}

/**
 * Validates a fine-grained PAT before storing it as the service token by
 * reading the classroom50 repo *as the supplied token* and asserting it can
 * WRITE (permissions.push), mapping failures to actionable messages.
 *
 * The shared token needs Contents: Read and write, Actions: Read and write, AND
 * Administration: Read and write on student repos: collect-scores reads, regrade
 * (re-running an autograde run, or pushing a submit/* tag) WRITES, and collect
 * grants staff teams (e.g. TAs) repo access via PUT /orgs/{org}/teams/{slug}/repos/...
 * which needs Administration. We can't introspect a fine-grained PAT's Actions
 * scope via the API, so we assert the Contents write capability
 * (permissions.push) AND the admin capability (permissions.admin) here — a
 * read-only or admin-less token is rejected — and the UI instructs the teacher
 * to also grant Actions: Read and write. Mirrors the CLI's
 * servicetoken.validateTokenWithClient.
 *
 * Caveat: GET /repos/{org}/classroom50 proves access to the config repo, not the
 * student repos the workflows touch (fine-grained PATs don't expose their repo
 * selection via the API). Hence the UI requires "All repositories".
 */
export async function validateServiceToken(
  token: string,
  org: string | undefined,
) {
  if (!org) throw new Error("org must be specified to validate a service token")

  const trimmed = token.trim()
  if (!trimmed) throw new Error("Enter a token before saving.")

  // NEVER log the token value — only the action + org.
  logSetup.info("validating service token", { org })

  const tokenClient = createGitHubClient({ token: trimmed })

  const scopeHint =
    `Create a fine-grained PAT with Resource owner = ${org}, Repository access = ` +
    "All repositories, Repository permissions → Contents: Read and write " +
    "AND Actions: Read and write AND Administration: Read and write (collecting " +
    "scores reads and grants staff teams repo access; regrading re-runs " +
    "student autograde workflows and may push submit/* tags, which need write), " +
    "AND Organization permissions → Members: Read (collection is team-driven and " +
    "lists the classroom team — a separate section shown once the org is the " +
    "resource owner; not implied by any repository scope). " +
    "If your org requires PAT approval and you are not an org owner, an owner " +
    "must approve it first (owners' tokens are auto-approved)."

  let repo: { permissions?: { push?: boolean; admin?: boolean } }
  try {
    // Probes api.github.com directly with the pasted token, relying on GitHub's
    // permissive CORS on authenticated REST calls. The repo object's
    // `permissions` reflects the token's effective access (push === can write,
    // admin === can administer).
    repo = await tokenClient.request<{
      permissions?: { push?: boolean; admin?: boolean }
    }>(`/repos/${org}/${CONFIG_REPO}`)
  } catch (err) {
    if (err instanceof GitHubAPIError) {
      if (err.status === 401) {
        throw new Error(
          "This token is invalid, expired, or revoked (401). Create a fresh fine-grained PAT and try again.",
          { cause: err },
        )
      }
      if (err.status === 403) {
        throw new Error(
          `This token can't access ${org}/${CONFIG_REPO} (403). ${scopeHint}`,
          { cause: err },
        )
      }
      if (err.status === 404) {
        throw new Error(
          `Couldn't find a ${CONFIG_REPO} repository in ${org} (404). Check that the organization is correct and that setup has been run for it — this isn't necessarily a problem with the token itself.`,
          { cause: err },
        )
      }
    }
    // A fetch that never reached GitHub (network/CORS) throws a TypeError, not a
    // GitHubAPIError — don't blame the token for that.
    if (err instanceof TypeError) {
      throw new Error(
        `Couldn't reach GitHub to verify the token (network or CORS issue). Check your connection and try again. (${err.message})`,
        { cause: err },
      )
    }
    throw new Error(
      `Couldn't verify the token against ${org}/${CONFIG_REPO}: ${getErrorMessage(
        err,
      )}`,
      { cause: err },
    )
  }

  // The token can read the repo, but regrade needs to write (re-run runs / push
  // submit/* tags). A read-only PAT reports permissions.push === false; reject
  // it with the same actionable scope hint.
  if (!repo.permissions?.push) {
    throw new Error(
      `This token can read ${org}/${CONFIG_REPO} but lacks write access — collecting scores needs read, but regrading needs write. ${scopeHint}`,
    )
  }

  // Contents is proven, but collect grants staff teams repo access, needing
  // Administration (not implied by Contents); reject an admin-less token here.
  if (!repo.permissions?.admin) {
    throw new Error(
      `This token can read and write ${org}/${CONFIG_REPO} but lacks admin access — collecting scores grants staff teams (e.g. TAs) read access to student repos, which needs Administration: write. ${scopeHint}`,
    )
  }

  // Contents/Actions are proven, but collection is team-driven: it lists the
  // classroom team's members, which needs the org-level Members: Read permission
  // — NOT implied by any repository scope, so a Contents/Actions-only token
  // passes every check above yet 403s on the first collect-scores API call.
  // Probe GET /orgs/{org}/members (same Members: Read permission the
  // team-members endpoint needs, but not dependent on a specific team existing).
  //
  // FAIL-OPEN on ambiguity: a 403/404 is a definitive scope gap and is rejected;
  // any other failure (401 after a 200 repo read, 5xx, rate-limit, network/CORS)
  // is inconclusive and allowed to proceed — the repo read above already proved
  // the token live, so blocking on this second round-trip's flakiness would
  // reject a valid token. The probe-token.yaml workflow is the exhaustive
  // post-provision signal.
  try {
    await tokenClient.request(
      `/orgs/${encodeURIComponent(org)}/members?per_page=1`,
    )
  } catch (err) {
    if (
      err instanceof GitHubAPIError &&
      (err.status === 403 || err.status === 404)
    ) {
      throw new Error(
        `This token can read ${org}/${CONFIG_REPO} but can't read the org's members — collecting scores is team-driven and lists the classroom team, which needs Organization permissions → Members: Read. ${scopeHint}`,
        { cause: err },
      )
    }
    // Inconclusive (401/5xx/network) — proceed; the repo read already proved the
    // token valid.
  }
}

export async function putRepoSecret(
  client: GitHubClient,
  owner: string | undefined,
  repo: string,
  name: string,
  plaintext: string,
) {
  if (!owner) throw new Error(`org must be specified to create a PAT`)
  const key = await client.request<{
    key_id: string
    key: string
  }>(`/repos/${owner}/${repo}/actions/secrets/public-key`)

  const encryptedValue = await encryptSecret(key.key, plaintext)

  // Log the write, never the plaintext/encrypted value.
  logSetup.info("writing repo Actions secret", { owner, repo, name })

  await client.request(`/repos/${owner}/${repo}/actions/secrets/${name}`, {
    method: "PUT",
    body: {
      encrypted_value: encryptedValue,
      key_id: key.key_id,
    },
  })
}
