import { createGitHubClient } from "../client"
import { GitHubAPIError } from "../errors"
import sodium from "libsodium-wrappers"
import { getErrorMessage } from "../errorMessage"
import { CONFIG_REPO } from "@/util/configRepo"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_GITHUB_SETUP } from "@/lib/logScopes"
import {
  localizedError,
  type LocalizedMessage,
  type LocalizedParam,
} from "@/types/localizedMessage"
import type { GitHubClient } from "../client"
import type { GitHubRepo } from "../types"

const logSetup = logger.scope(LOG_SCOPE_GITHUB_SETUP)

// The token-validation copy, one en.json key per rejection so the view renders
// it translated (errorText) instead of assembled text. Literal keys, so the
// i18n audit can see each one is referenced.
const VALIDATE_KEYS = {
  empty: "orgSettings.serviceToken.validate.empty",
  scopeHint: "orgSettings.serviceToken.validate.scopeHint",
  invalid: "orgSettings.serviceToken.validate.invalid",
  noAccess: "orgSettings.serviceToken.validate.noAccess",
  configRepoMissing: "orgSettings.serviceToken.validate.configRepoMissing",
  unreachable: "orgSettings.serviceToken.validate.unreachable",
  unverified: "orgSettings.serviceToken.validate.unverified",
  readOnly: "orgSettings.serviceToken.validate.readOnly",
  noAdmin: "orgSettings.serviceToken.validate.noAdmin",
  noMembersRead: "orgSettings.serviceToken.validate.noMembersRead",
  selectedRepos: "orgSettings.serviceToken.validate.selectedRepos",
} as const
type ValidateKey = keyof typeof VALIDATE_KEYS

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
 * grants staff teams (e.g., TAs) repo access via PUT /orgs/{org}/teams/{slug}/repos/...
 * which needs Administration. We can't introspect a fine-grained PAT's Actions
 * scope via the API, so we assert the Contents write capability
 * (permissions.push) AND the admin capability (permissions.admin) here — a
 * read-only or admin-less token is rejected — and the UI instructs the teacher
 * to also grant Actions: Read and write. Mirrors the CLI's
 * servicetoken.validateTokenWithClient.
 *
 * Caveat: GET /repos/{org}/classroom50 proves access to the config repo, not the
 * student repos the workflows touch (fine-grained PATs don't expose their repo
 * selection via the API). Hence the UI requires "All repositories", and when
 * `teacherClient` is supplied the token is also made to read one other private
 * org repo (see assertTokenReachesOtherRepos).
 */
export async function validateServiceToken(
  token: string,
  org: string | undefined,
  teacherClient?: GitHubClient,
) {
  if (!org) throw new Error("org must be specified to validate a service token")

  const trimmed = token.trim()
  if (!trimmed) throw localizedError({ key: VALIDATE_KEYS.empty })

  // NEVER log the token value — only the action + org.
  logSetup.info("validating service token", { org })

  const tokenClient = createGitHubClient({ token: trimmed })

  const hint: LocalizedMessage = {
    key: VALIDATE_KEYS.scopeHint,
    params: { org },
  }
  const fail = (
    key: ValidateKey,
    params: Record<string, LocalizedParam> = {},
    cause?: unknown,
  ): Error => {
    const err = localizedError({
      key: VALIDATE_KEYS[key],
      params: { org, repo: CONFIG_REPO, ...params },
    })
    if (cause !== undefined) err.cause = cause
    return err
  }

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
      if (err.status === 401) throw fail("invalid", {}, err)
      if (err.status === 403) throw fail("noAccess", { hint }, err)
      if (err.status === 404) throw fail("configRepoMissing", {}, err)
    }
    // A fetch that never reached GitHub (network/CORS) throws a TypeError, not a
    // GitHubAPIError — don't blame the token for that.
    if (err instanceof TypeError) {
      throw fail("unreachable", { reason: err.message }, err)
    }
    throw fail("unverified", { reason: getErrorMessage(err) }, err)
  }

  // The token can read the repo, but regrade needs to write (re-run runs / push
  // submit/* tags). A read-only PAT reports permissions.push === false; reject
  // it with the same actionable scope hint.
  if (!repo.permissions?.push) throw fail("readOnly", { hint })

  // Contents is proven, but collect grants staff teams repo access, needing
  // Administration (not implied by Contents); reject an admin-less token here.
  if (!repo.permissions?.admin) throw fail("noAdmin", { hint })

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
      throw fail("noMembersRead", { hint }, err)
    }
    // Inconclusive (401/5xx/network) — proceed; the repo read already proved the
    // token valid.
  }

  if (teacherClient) {
    await assertTokenReachesOtherRepos(tokenClient, teacherClient, org)
  }
}

// The config-repo read proves nothing about the student repos: a token scoped
// to "Only select repositories" (with classroom50 selected) passes every check
// above, then 404s on every student repo, which surfaces weeks later as a
// collect-time 403 on the first staff-team grant. The teacher's own client
// picks a private org repo other than classroom50 (one they can see, so a token
// they own with All repositories sees it too) and the token reads it. Only a
// 404 is a verdict; no other private repo means nothing to prove, and any other
// failure is inconclusive (the probe-token workflow is the exhaustive check).
async function assertTokenReachesOtherRepos(
  tokenClient: GitHubClient,
  teacherClient: GitHubClient,
  org: string,
) {
  let repos: Pick<GitHubRepo, "name">[]
  try {
    repos = await teacherClient.request<Pick<GitHubRepo, "name">[]>(
      `/orgs/${encodeURIComponent(org)}/repos?type=private&sort=created&direction=asc&per_page=10`,
    )
  } catch {
    return
  }
  const probe = repos.find(
    (r) => r.name.toLowerCase() !== CONFIG_REPO.toLowerCase(),
  )
  if (!probe) return
  try {
    await tokenClient.request(
      `/repos/${encodeURIComponent(org)}/${encodeURIComponent(probe.name)}`,
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) {
      const failure = localizedError({
        key: VALIDATE_KEYS.selectedRepos,
        params: { org, repo: CONFIG_REPO, probe: probe.name },
      })
      failure.cause = err
      throw failure
    }
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

// Upserts a repo-level Actions VARIABLE (plaintext, readable back — unlike a
// secret). GitHub has no PUT for variables: create is POST /variables, update
// is PATCH /variables/{name}. We PATCH first (rotation is the common case) and
// fall back to POST on 404 (first-ever write). The value here is non-secret
// metadata (an expiry date), so — unlike putRepoSecret — it is not sealed.
export async function putRepoVariable(
  client: GitHubClient,
  owner: string | undefined,
  repo: string,
  name: string,
  value: string,
) {
  if (!owner) throw new Error("org must be specified to write a repo variable")

  // Log the write, never the value: putRepoVariable is a generic repo-variable
  // writer, so mirror putRepoSecret and omit the value rather than assume every
  // caller's value is non-secret.
  logSetup.info("writing repo Actions variable", { owner, repo, name })

  try {
    await client.request(`/repos/${owner}/${repo}/actions/variables/${name}`, {
      method: "PATCH",
      body: { name, value },
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) {
      await client.request(`/repos/${owner}/${repo}/actions/variables`, {
        method: "POST",
        body: { name, value },
      })
      return
    }
    throw err
  }
}
