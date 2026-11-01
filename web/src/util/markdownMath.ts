import type { Nodes, Parents } from "mdast"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import { unified } from "unified"

// Teachers write descriptions in GitHub's Markdown dialect, whose math rules
// are stricter than remark-math's: an inline `$` opener must be followed by a
// non-space, and the closer must be preceded by a non-space and not followed
// by a digit, so "$5 and $10" stays prose. GitHub also accepts the $`…`$ form
// for expressions that collide with Markdown syntax. This pass rewrites the
// source so remark-math reproduces GitHub's reading: openers that can't close
// under those rules are escaped (`\$`), and the backtick form becomes `$…$`.
//
// Which text is prose comes from the real parser, not a second tokenizer:
// code blocks (fenced, indented, nested in lists or quotes), code spans, raw
// HTML, autolinks, and link reference definitions are literal in CommonMark,
// so they are copied byte for byte and never scanned for dollars.

export type PreparedMath = {
  text: string
  // True when the rewritten text contains something remark-math will turn
  // into a math node, so the caller can skip loading the renderer otherwise.
  hasMath: boolean
}

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch)
const isDigit = (ch: string | undefined) => ch !== undefined && /[0-9]/.test(ch)

const parser = unified().use(remarkParse).use(remarkGfm)

type Range = { start: number; end: number }

// Offset ranges of every CommonMark construct whose content is literal, in
// document order, plus whether a ```math fence appeared. Links are protected
// only when written as autolinks: a `[text](url)` link's text is prose, and
// backslash escapes are decoded inside its destination anyway.
function literalRanges(source: string): {
  ranges: Range[]
  mathFence: boolean
} {
  const ranges: Range[] = []
  let mathFence = false
  const visit = (node: Nodes) => {
    const pos = node.position
    if (pos?.start.offset !== undefined && pos.end.offset !== undefined) {
      const range = { start: pos.start.offset, end: pos.end.offset }
      switch (node.type) {
        case "code":
          if (node.lang === "math") mathFence = true
          ranges.push(range)
          return
        case "inlineCode":
        case "html":
        case "definition":
          ranges.push(range)
          return
        case "link":
          if (source[range.start] !== "[") {
            ranges.push(range)
            return
          }
      }
    }
    if ("children" in node) {
      for (const child of (node as Parents).children) visit(child)
    }
  }
  visit(parser.parse(source))
  return { ranges, mathFence }
}

export function normalizeGitHubMath(source: string): PreparedMath {
  const { ranges, mathFence } = literalRanges(source)
  let out = ""
  let i = 0
  let next = 0
  let hasMath = mathFence
  const n = source.length

  // Finds the next unescaped single `$` starting at `from`, stopping at a
  // blank line (inline math can't span paragraphs). Returns -1 if none.
  const findInlineCloser = (from: number): number => {
    for (let j = from; j < n; j++) {
      const ch = source[j]
      if (ch === "\\") {
        j++
        continue
      }
      if (ch === "\n" && source[j + 1] === "\n") return -1
      if (ch === "$") {
        if (source[j + 1] === "$") {
          j++
          continue
        }
        return j
      }
    }
    return -1
  }

  // remark-math has no escape handling inside `$…$`: the first `$` closes,
  // escaped or not. A body that needs a literal dollar is wrapped in `$$`
  // instead, which rehype-katex still renders inline because display mode
  // follows the `math-display` class, not the delimiter length.
  const emitInline = (body: string) => {
    const d = body.includes("\\$") ? "$$" : "$"
    out += `${d}${body}${d}`
    hasMath = true
  }

  while (i < n) {
    while (next < ranges.length && ranges[next].end <= i) next++
    const literal = ranges[next]
    if (literal && literal.start <= i) {
      out += source.slice(i, literal.end)
      i = literal.end
      continue
    }

    const ch = source[i]

    if (ch === "\\") {
      out += source.slice(i, i + 2)
      i += 2
      continue
    }

    if (ch !== "$") {
      out += ch
      i++
      continue
    }

    if (source[i + 1] === "$") {
      const close = source.indexOf("$$", i + 2)
      if (close === -1) {
        out += "$$"
        i += 2
      } else {
        out += source.slice(i, close + 2)
        i = close + 2
        hasMath = true
      }
      continue
    }

    if (source[i + 1] === "`") {
      const close = source.indexOf("`$", i + 2)
      if (close !== -1) {
        emitInline(source.slice(i + 2, close).replace(/\$/g, "\\$"))
        i = close + 2
        continue
      }
    }

    const close = findInlineCloser(i + 1)
    const valid =
      close !== -1 &&
      !isSpace(source[i + 1]) &&
      !isSpace(source[close - 1]) &&
      !isDigit(source[close + 1])
    if (valid) {
      emitInline(source.slice(i + 1, close))
      i = close + 1
    } else {
      out += "\\$"
      i++
    }
  }

  return { text: out, hasMath }
}
