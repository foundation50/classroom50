// Google Analytics (loaded through Google Tag Manager) sets `_ga`, `_ga_<ID>`,
// `_gid`, and `_gat*` cookies on the site's registrable domain. Opting out
// stops the script from loading on the next page load; this removes what it
// already set, so the opt-out leaves nothing behind. Cloudflare Web Analytics
// sets no cookies, so there is nothing of its to clear.
const GOOGLE_ANALYTICS_COOKIE = /^_g(a|id|at)(_|$)/

// The hostname and each parent with at least two labels: a cookie set with
// `domain=classroom50.org` from preview.classroom50.org can only be expired by
// naming that domain again.
function candidateDomains(hostname: string): (string | undefined)[] {
  const labels = hostname.split(".")
  const parents = labels
    .map((_, i) => labels.slice(i).join("."))
    .filter((d) => d.includes("."))
  return [undefined, ...parents]
}

export function clearAnalyticsCookies(
  doc: { cookie: string } = document,
  hostname: string = location.hostname,
): void {
  const names = doc.cookie
    .split(";")
    .map((pair) => pair.split("=")[0].trim())
    .filter((name) => GOOGLE_ANALYTICS_COOKIE.test(name))
  const domains = candidateDomains(hostname)
  for (const name of names) {
    for (const domain of domains) {
      doc.cookie =
        `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/` +
        (domain ? `; domain=${domain}` : "")
    }
  }
}
