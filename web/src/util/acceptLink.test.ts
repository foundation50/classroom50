// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"

import { acceptLinkCli, acceptLinkUrl } from "./acceptLink"

const origin = () => window.location.origin

describe("acceptLinkUrl", () => {
  it("builds the accept path from the app origin and identifiers", () => {
    expect(acceptLinkUrl("acme", "cs101", "hw1")).toBe(
      `${origin()}/acme/cs101/assignments/hw1/accept`,
    )
  })

  it("carries a protected classroom's secret as the ?k= key", () => {
    expect(acceptLinkUrl("acme", "cs101", "hw1", "ab12cd34")).toBe(
      `${origin()}/acme/cs101/assignments/hw1/accept?k=ab12cd34`,
    )
  })

  it("treats an empty secret as unprotected", () => {
    expect(acceptLinkUrl("acme", "cs101", "hw1", "")).toBe(
      `${origin()}/acme/cs101/assignments/hw1/accept`,
    )
  })

  it("URL-encodes the secret defensively", () => {
    // A well-formed secret is [a-z0-9] and unaffected; a looser value must not
    // break out of the query value.
    expect(acceptLinkUrl("acme", "cs101", "hw1", "a&b=c")).toBe(
      `${origin()}/acme/cs101/assignments/hw1/accept?k=a%26b%3Dc`,
    )
  })
})

describe("acceptLinkCli", () => {
  it("builds the plain accept command", () => {
    expect(acceptLinkCli("acme", "cs101", "hw1")).toBe(
      "gh student accept acme cs101 hw1",
    )
  })

  it("appends --key for a protected classroom", () => {
    expect(acceptLinkCli("acme", "cs101", "hw1", "ab12cd34")).toBe(
      "gh student accept acme cs101 hw1 --key ab12cd34",
    )
  })
})
