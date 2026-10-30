// Teachers write descriptions in GitHub's Markdown dialect, whose math rules
// are stricter than remark-math's: an inline `$` opener must be followed by a
// non-space, and the closer must be preceded by a non-space and not followed
// by a digit, so "$5 and $10" stays prose. GitHub also accepts the $`…`$ form
// for expressions that collide with Markdown syntax. This pass rewrites the
// source so remark-math reproduces GitHub's reading: openers that can't close
// under those rules are escaped (`\$`), and the backtick form becomes `$…$`.
// Code spans, fenced blocks, and `$$` display math are copied verbatim.

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch)
const isDigit = (ch: string | undefined) => ch !== undefined && /[0-9]/.test(ch)

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

export function normalizeGitHubMath(source: string): string {
  let out = ""
  let i = 0
  const n = source.length

  // Fenced code: copy whole lines until the closing fence (same marker, at
  // least as long). An unterminated fence runs to the end, as in CommonMark.
  const copyFence = (marker: string) => {
    for (;;) {
      const eol = source.indexOf("\n", i)
      const lineEnd = eol === -1 ? n : eol + 1
      out += source.slice(i, lineEnd)
      i = lineEnd
      if (i >= n) return
      const nextEol = source.indexOf("\n", i)
      const line = source.slice(i, nextEol === -1 ? n : nextEol)
      const close = FENCE_OPEN.exec(line)
      if (
        close &&
        close[1][0] === marker[0] &&
        close[1].length >= marker.length &&
        line.slice(close[0].length).trim() === ""
      ) {
        const closeEnd = nextEol === -1 ? n : nextEol + 1
        out += source.slice(i, closeEnd)
        i = closeEnd
        return
      }
    }
  }

  // A code span closes only on a backtick run of exactly the opener's length.
  const findTickRun = (from: number, len: number): number => {
    let j = from
    while (j < n) {
      if (source[j] !== "`") {
        j++
        continue
      }
      let k = j
      while (source[k] === "`") k++
      if (k - j === len) return j
      j = k
    }
    return -1
  }

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

  while (i < n) {
    const atLineStart = i === 0 || source[i - 1] === "\n"
    if (atLineStart) {
      const eol = source.indexOf("\n", i)
      const line = source.slice(i, eol === -1 ? n : eol)
      const fence = FENCE_OPEN.exec(line)
      if (fence) {
        copyFence(fence[1])
        continue
      }
    }

    const ch = source[i]

    if (ch === "\\") {
      out += source.slice(i, i + 2)
      i += 2
      continue
    }

    if (ch === "`") {
      let run = i
      while (source[run] === "`") run++
      const len = run - i
      const close = findTickRun(run, len)
      if (close === -1) {
        out += source.slice(i, run)
        i = run
      } else {
        out += source.slice(i, close + len)
        i = close + len
      }
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
      }
      continue
    }

    if (source[i + 1] === "`") {
      const close = source.indexOf("`$", i + 2)
      if (close !== -1) {
        // KaTeX renders `\$` as a literal dollar, so an inner `$` can't end the
        // expression early once rewritten to the plain delimiter form.
        const body = source.slice(i + 2, close).replace(/\$/g, "\\$")
        out += `$${body}$`
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
      out += source.slice(i, close + 1)
      i = close + 1
    } else {
      out += "\\$"
      i++
    }
  }

  return out
}

const MATH_FENCE = /^ {0,3}(?:`{3,}|~{3,}) *math\b/m

// Whether rendering `source` needs the math engine at all: an unescaped `$`
// delimiter or a ```math fence. Run on normalized text, so escaped prose
// dollars no longer count.
export function containsMath(source: string): boolean {
  return /(?:^|[^\\])\$/.test(source) || MATH_FENCE.test(source)
}
