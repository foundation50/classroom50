import { describe, expect, it } from "vitest"

import { containsMath, normalizeGitHubMath } from "./markdownMath"

describe("normalizeGitHubMath", () => {
  it("keeps valid inline and display math untouched", () => {
    const src = String.raw`Inline $c=\frac{a+b}{2}$ then

$$
S(a,b)=\frac{b-a}{6}\left[f(a)+4f(c)+f(b)\right].
$$`
    expect(normalizeGitHubMath(src)).toBe(src)
  })

  it("escapes dollar amounts that GitHub would not read as math", () => {
    expect(normalizeGitHubMath("Costs $5 and $10 each")).toBe(
      String.raw`Costs \$5 and \$10 each`,
    )
  })

  it("lets a later valid pair close after an invalid opener", () => {
    expect(normalizeGitHubMath("Budget $5, then $x^2$")).toBe(
      String.raw`Budget \$5, then $x^2$`,
    )
  })

  it("rejects an opener followed by a space or a closer preceded by one", () => {
    expect(normalizeGitHubMath("a $ x$ b")).toBe(String.raw`a \$ x\$ b`)
    expect(normalizeGitHubMath("a $x $ b")).toBe(String.raw`a \$x \$ b`)
  })

  it("does not let inline math span a blank line", () => {
    expect(normalizeGitHubMath("one $a\n\nb$ two")).toBe("one \\$a\n\nb\\$ two")
  })

  it("rewrites GitHub's backtick form to plain delimiters", () => {
    expect(normalizeGitHubMath("see $`\\sqrt{3x-1}+(1+x)^2`$ here")).toBe(
      "see $\\sqrt{3x-1}+(1+x)^2$ here",
    )
    expect(normalizeGitHubMath("$`\\text{$}`$")).toBe("$\\text{\\$}$")
  })

  it("leaves code spans and fenced blocks alone", () => {
    const src =
      "run `echo $HOME` then\n\n```sh\necho $5 and $10\n```\n\nand $5 more"
    expect(normalizeGitHubMath(src)).toBe(
      "run `echo $HOME` then\n\n```sh\necho $5 and $10\n```\n\nand \\$5 more",
    )
  })

  it("matches a code span only on an equal-length backtick run", () => {
    expect(normalizeGitHubMath("``a ` $b`` $5")).toBe("``a ` $b`` \\$5")
  })

  it("preserves existing escapes", () => {
    const src = String.raw`pay \$5 for $x$`
    expect(normalizeGitHubMath(src)).toBe(src)
  })
})

describe("containsMath", () => {
  it("detects unescaped delimiters and math fences", () => {
    expect(containsMath("a $x$ b")).toBe(true)
    expect(containsMath("$$\nx\n$$")).toBe(true)
    expect(containsMath("```math\nx\n```")).toBe(true)
  })

  it("ignores escaped dollars and plain prose", () => {
    expect(containsMath(String.raw`pay \$5`)).toBe(false)
    expect(containsMath("# Title\n\n- one")).toBe(false)
  })
})
