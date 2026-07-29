import {
  GitHubAPIError,
  githubNonJsonResponseError,
  readGitHubRateLimitHeaders,
  githubValidationReasons,
} from "./errors"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_GITHUB_CLIENT } from "@/lib/logScopes"
import { countApiCall, publishRateLimit } from "@/lib/diagnostics/rateLimit"

const log = logger.scope(LOG_SCOPE_GITHUB_CLIENT)

// Bound every request so a half-open GitHub connection can't pin a poll or
// mutation forever (React Query imposes no request timeout; the banner uses
// retry:false). Wider than the 5s github.io probes since these are authed API
// calls.
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000

export type GitHubClient = {
  request: <T = unknown>(
    path: string,
    options?: GitHubRequestOptions,
  ) => Promise<T>

  requestRaw: (path: string, options?: GitHubRequestOptions) => Promise<string>

  // Fetch a repo zip via the archive-proxy Worker: the GitHub archive endpoint
  // 302s to codeload (no CORS header), so the Worker follows the redirect
  // server-side with this token and streams bytes back with CORS. Throws if no
  // proxy is configured.
  fetchArchive: (
    owner: string,
    repo: string,
    options?: { ref?: string; signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<GitHubBinaryResponse>
}

// Binary body plus the filename GitHub advertised (from Content-Disposition).
export type GitHubBinaryResponse = {
  bytes: ArrayBuffer
  filename?: string
}

export type GitHubRequestOptions = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  body?: unknown
  accept?: string
  signal?: AbortSignal
  headers?: Record<string, string>
  // Composed with `signal`; defaults to DEFAULT_REQUEST_TIMEOUT_MS. Pass a
  // larger value for a legitimately long call, or `0` to opt out.
  timeoutMs?: number
}

// Per-response signal about the token's live state, reported to the provider
// for the session/scope banner. Fires on every response (success and error)
// before any throw.
export type GitHubResponseSignal = {
  status: number
  scopes: string | null
}

export function createGitHubClient(args: {
  token: string
  apiBaseUrl?: string
  // Base URL of the archive-proxy Worker (see fetchArchive). When omitted,
  // fetchArchive throws — archive download is unavailable without the proxy.
  archiveBaseUrl?: string
  onResponse?: (signal: GitHubResponseSignal) => void
}): GitHubClient {
  const apiBaseUrl = args.apiBaseUrl ?? "https://api.github.com"

  async function requestInternal(
    path: string,
    options: GitHubRequestOptions = { method: "GET" },
  ): Promise<Response> {
    // Count every outbound call at the single choke point (covers request +
    // requestRaw; fetchArchive counts itself since it bypasses this proxy) —
    // before the fetch, so a thrown/timed-out call still counts.
    countApiCall()

    const url = path.startsWith("http")
      ? path
      : `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`

    const headers: Record<string, string> = {
      Authorization: `Bearer ${args.token}`,
      Accept: options.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      ...options.headers,
    }

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json"
    }

    // Abort on whichever fires first: the caller's signal or the timeout. A
    // timeout surfaces as a rejected fetch, handled like any other rejection.
    const signal = composeAbortSignal(options.signal, options.timeoutMs)

    const method = options.method ?? "GET"
    log.debug("request", { method, path })

    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
        cache: options.method === "GET" ? "no-store" : undefined,
      })
    } catch (err) {
      // A rejected fetch is an abort (caller cancel or our timeout) or a network
      // failure. Distinguish so a timeout doesn't read as a mystery error; never
      // log the token/headers/body — just method + path.
      const aborted = err instanceof DOMException && err.name === "AbortError"
      if (aborted) {
        log.debug("request aborted", { method, path })
      } else {
        log.warn("request network error", { method, path })
      }
      throw err
    }

    // Report the token's live state to the provider before any throw, so the
    // 401/403 revocation path still surfaces. `scopes` is the X-OAuth-Scopes
    // header (`null` when absent, e.g., a fine-grained PAT — distinct from an
    // empty grant); `status` lets the provider tell a dead token (401) from a
    // healthy one.
    args.onResponse?.({
      status: res.status,
      scopes: res.headers.get("x-oauth-scopes"),
    })

    const rateLimit = readGitHubRateLimitHeaders(res)
    // Publish to the dev rate-limit overlay instead of logging per-response
    // (that flooded the console). No-op in prod (nothing subscribes).
    publishRateLimit(rateLimit)

    if (!res.ok) {
      const { body, message } = await parseErrorResponse(
        res,
        `GitHub API request failed with ${res.status}`,
      )

      // Non-sensitive fields only — never the whole body, which can carry IP
      // allow lists or SAML detail. A 422 also gets its validation reasons (see
      // githubValidationReasons for why those are worth the extra field).
      log.debug("api error", {
        method,
        path,
        status: res.status,
        requestId: res.headers.get("x-github-request-id"),
        ...(res.status === 422
          ? { validation: githubValidationReasons(body) }
          : {}),
      })

      throw new GitHubAPIError({
        status: res.status,
        url,
        message,
        body,
        rateLimit,
        ssoHeader: res.headers.get("x-github-sso"),
        acceptedScopes: res.headers.get("x-accepted-oauth-scopes"),
        oauthScopes: res.headers.get("x-oauth-scopes"),
        requestId: res.headers.get("x-github-request-id"),
      })
    }

    log.debug("response", { method, path, status: res.status })
    return res
  }

  return {
    async request<T>(path: string, options?: GitHubRequestOptions) {
      const res = await requestInternal(path, options)

      if (res.status === 204 || res.status === 205) {
        return undefined as T
      }

      const text = await res.text()

      if (!text.trim()) {
        return undefined as T
      }

      try {
        return JSON.parse(text) as T
      } catch {
        // A 2xx whose body isn't JSON means the response never reached GitHub's
        // app layer — an edge/proxy served HTML (a known GitHub-outage shape:
        // "requests not consistently reaching the application layer, returning
        // HTML instead of the expected API format"). Surface it as a synthetic
        // 5xx so it classifies as outage-shaped (feeds the health detector and
        // the outage hint) instead of leaking a raw `SyntaxError` to the user.
        throw githubNonJsonResponseError(
          res.url || path,
          res.status,
          res.headers.get("x-github-request-id"),
        )
      }
    },

    async requestRaw(path: string, options?: GitHubRequestOptions) {
      const res = await requestInternal(path, {
        method: options?.method ?? "GET",
        ...options,
        accept: options?.accept ?? "application/vnd.github.raw+json",
      })

      return await res.text()
    },

    async fetchArchive(
      owner: string,
      repo: string,
      options?: { ref?: string; signal?: AbortSignal; timeoutMs?: number },
    ) {
      if (!args.archiveBaseUrl) {
        throw new Error("archive proxy is not configured")
      }

      // Fail closed rather than send the bearer to a non-https origin: a
      // misconfigured base (http / wrong host) could exfiltrate the token.
      const base = new URL(args.archiveBaseUrl)
      const isLocalhost =
        base.hostname === "localhost" ||
        base.hostname === "127.0.0.1" ||
        base.hostname === "[::1]"
      if (base.protocol !== "https:" && !isLocalhost) {
        throw new Error("archive proxy must be an https origin")
      }

      // Count against the diagnostics overlay like any other GitHub call, even
      // though this one hops through the proxy.
      countApiCall()

      // Encode each segment (defense-in-depth for a future ref caller); encode
      // ref per-segment since a ref legitimately contains `/`.
      const encodedRef = options?.ref
        ? options.ref.split("/").map(encodeURIComponent).join("/")
        : ""
      const path =
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball` +
        (encodedRef ? `/${encodedRef}` : "")
      const url = `${args.archiveBaseUrl.replace(/\/$/, "")}${path}`

      // Archives are larger than API responses; default to a generous timeout.
      const signal = composeAbortSignal(
        options?.signal,
        options?.timeoutMs,
        60000,
      )

      log.debug("archive request", { owner, repo, ref: options?.ref })

      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${args.token}` },
        signal,
      })

      // Report token liveness like requestInternal so a revoked token still
      // tears the session down when the proxy relays a 401.
      args.onResponse?.({
        status: res.status,
        scopes: res.headers.get("x-oauth-scopes"),
      })

      if (!res.ok) {
        const { body, message } = await parseErrorResponse(
          res,
          `Archive request failed with ${res.status}`,
        )
        throw new GitHubAPIError({
          status: res.status,
          url,
          message,
          body,
          rateLimit: readGitHubRateLimitHeaders(res),
          requestId: res.headers.get("x-github-request-id"),
        })
      }

      const bytes = await res.arrayBuffer()
      const filename = parseContentDispositionFilename(
        res.headers.get("content-disposition"),
      )

      return { bytes, filename }
    },
  }
}

// Compose the caller's abort signal with a timeout signal, aborting on whichever
// fires first. `timeoutMs` 0 opts out of the timeout.
function composeAbortSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  defaultMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): AbortSignal | undefined {
  const ms = timeoutMs ?? defaultMs
  const timeoutSignal = ms > 0 ? AbortSignal.timeout(ms) : undefined
  return callerSignal && timeoutSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : (callerSignal ?? timeoutSignal)
}

// Parse a non-OK response body as JSON (falling back to raw text) and derive
// the error message from its `message` field, else `fallback`.
async function parseErrorResponse(
  res: Response,
  fallback: string,
): Promise<{ body: unknown; message: string }> {
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  const message =
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
      ? body.message
      : fallback
  return { body, message }
}

// Extract the filename from Content-Disposition, preferring RFC 5987
// `filename*` over plain `filename` (RFC 6266). undefined if absent.
function parseContentDispositionFilename(
  header: string | null,
): string | undefined {
  if (!header) return undefined

  const safeDecode = (value: string) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }

  const ext = /filename\*=\s*(?:([\w-]+)'[^']*')?"?([^";]+?)"?\s*(?:;|$)/i.exec(
    header,
  )
  if (ext) return safeDecode(ext[2].trim())

  const plain = /filename=\s*"?([^";]+?)"?\s*(?:;|$)/i.exec(header)
  return plain ? safeDecode(plain[1].trim()) : undefined
}
