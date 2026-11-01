import { describe, expect, it } from "vitest"

import { normalizeGitHubMath } from "./markdownMath"

const text = (source: string) => normalizeGitHubMath(source).text
const hasMath = (source: string) => normalizeGitHubMath(source).hasMath

describe("normalizeGitHubMath", () => {
  it("keeps valid inline and display math untouched", () => {
    const src = String.raw`Inline $c=\frac{a+b}{2}$ then

$$
S(a,b)=\frac{b-a}{6}\left[f(a)+4f(c)+f(b)\right].
$$`
    expect(text(src)).toBe(src)
  })

  it("escapes dollar amounts that GitHub would not read as math", () => {
    expect(text("Costs $5 and $10 each")).toBe(
      String.raw`Costs \$5 and \$10 each`,
    )
  })

  it("lets a later valid pair close after an invalid opener", () => {
    expect(text("Budget $5, then $x^2$")).toBe(
      String.raw`Budget \$5, then $x^2$`,
    )
  })

  it("rejects an opener followed by a space or a closer preceded by one", () => {
    expect(text("a $ x$ b")).toBe(String.raw`a \$ x\$ b`)
    expect(text("a $x $ b")).toBe(String.raw`a \$x \$ b`)
  })

  it("rejects a closer followed by a digit, as GitHub does", () => {
    // Both pairs pass the whitespace checks, so only the digit rule can
    // reject them.
    expect(text("Price range $5-$10")).toBe(String.raw`Price range \$5-\$10`)
    expect(text("a $x$5 b")).toBe(String.raw`a \$x\$5 b`)
  })

  it("does not let inline math span a blank line", () => {
    expect(text("one $a\n\nb$ two")).toBe("one \\$a\n\nb\\$ two")
  })

  it("rewrites GitHub's backtick form to plain delimiters", () => {
    expect(text("see $`\\sqrt{3x-1}+(1+x)^2`$ here")).toBe(
      "see $\\sqrt{3x-1}+(1+x)^2$ here",
    )
  })

  it("wraps a body with a literal dollar in $$ so remark-math cannot close early", () => {
    expect(text("$`\\text{$}`$")).toBe("$$\\text{\\$}$$")
    expect(text(String.raw`pay $\sqrt{\$4}$ now`)).toBe(
      String.raw`pay $$\sqrt{\$4}$$ now`,
    )
  })

  it("leaves code spans and fenced blocks alone", () => {
    const src =
      "run `echo $HOME` then\n\n```sh\necho $5 and $10\n```\n\nand $5 more"
    expect(text(src)).toBe(
      "run `echo $HOME` then\n\n```sh\necho $5 and $10\n```\n\nand \\$5 more",
    )
  })

  it("matches a code span only on an equal-length backtick run", () => {
    expect(text("``a ` $b`` $5")).toBe("``a ` $b`` \\$5")
  })

  it("leaves indented code blocks alone", () => {
    const src = "Run this:\n\n    echo $5 and $10\n    ls $HOME\n\nthen $5"
    expect(text(src)).toBe(
      "Run this:\n\n    echo $5 and $10\n    ls $HOME\n\nthen \\$5",
    )
  })

  it("leaves fences nested in quotes and list items alone", () => {
    const quoted = "> ~~~\n> echo $5 and $10\n> ~~~"
    expect(text(quoted)).toBe(quoted)
    const listed = "1. x\n\n   ```sh\n   echo $5 and $10\n   ```"
    expect(text(listed)).toBe(listed)
  })

  it("leaves autolinks, raw HTML, and link definitions alone", () => {
    const src =
      "see <https://x.com/?a=$5> or https://y.com/$6 and <a href='?q=$7'>x</a>\n\n[ref]: https://r.com/$8"
    expect(text(src)).toBe(src)
  })

  it("still escapes prose dollars inside a bracketed link's text", () => {
    expect(text("[costs $5](https://x.com)")).toBe(
      String.raw`[costs \$5](https://x.com)`,
    )
  })

  it("preserves existing escapes", () => {
    const src = String.raw`pay \$5 for $x$`
    expect(text(src)).toBe(src)
  })
})

describe("hasMath", () => {
  it("is true for inline math, display math, and math fences", () => {
    expect(hasMath("a $x$ b")).toBe(true)
    expect(hasMath("$$\nx\n$$")).toBe(true)
    expect(hasMath("```math\nx\n```")).toBe(true)
    expect(hasMath("$`\\sqrt{x}`$")).toBe(true)
  })

  it("is false for escaped dollars and plain prose", () => {
    expect(hasMath(String.raw`pay \$5`)).toBe(false)
    expect(hasMath("Costs $5 and $10 each")).toBe(false)
    expect(hasMath("# Title\n\n- one")).toBe(false)
  })

  it("is false when the only dollars are inside code", () => {
    expect(hasMath("run `echo $HOME` then")).toBe(false)
    expect(hasMath("```sh\necho $5\n```")).toBe(false)
    expect(hasMath("Run:\n\n    echo $5 and $10")).toBe(false)
  })
})
