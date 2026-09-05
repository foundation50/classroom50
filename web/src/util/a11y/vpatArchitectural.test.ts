import { readdirSync, readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { CRITERIA } from "./vpatModel"

// The architectural verdicts (Not Applicable for media, motion, and shortcut
// criteria; Supports for flashing) rest on "the source contains no X". Those
// rows carry the build date in the report, so something must actually re-check
// the claim on every build; this is that check. A hit here means the verdict
// needs re-assessing, not that the test is wrong.

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(here, "..", "..")

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(tsx?|css|html)$/.test(name) && !/\.test\./.test(name))
      out.push(full)
  }
  return out
}

// The a11y model itself and the /assess guidance name these tokens in prose.
const files = walk(srcRoot).filter(
  (f) => !f.includes(`${path.sep}a11y${path.sep}`),
)
const sources = files.map((f) => ({
  file: path.relative(srcRoot, f),
  text: readFileSync(f, "utf8"),
}))

const hits = (re: RegExp) =>
  sources.filter((s) => re.test(s.text)).map((s) => s.file)

const architectural = (id: string) => CRITERIA.find((c) => c.id === id)

describe("architectural verdicts hold against the current source", () => {
  it("1.2.x / 1.4.2: no audio, video, or embedded media", () => {
    for (const id of ["1.2.1", "1.2.2", "1.2.3", "1.2.4", "1.2.5", "1.4.2"]) {
      expect(architectural(id)?.evidence, id).toBe("architectural")
    }
    expect(hits(/<(video|audio|iframe|embed|object)\b/)).toEqual([])
    expect(hits(/new Audio\(|\.play\(\)/)).toEqual([])
  })

  it("2.5.4: nothing listens to device motion or orientation", () => {
    expect(architectural("2.5.4")?.evidence).toBe("architectural")
    expect(hits(/devicemotion|deviceorientation|DeviceMotionEvent/)).toEqual([])
  })

  it("2.1.4: no single-character key shortcuts", () => {
    expect(architectural("2.1.4")?.evidence).toBe("architectural")
    // A handler comparing key to a single printable character (letters, digits,
    // punctuation) outside a focused widget. Arrow/Enter/Escape/Tab are exempt.
    expect(
      hits(/\.key\s*===\s*["'][A-Za-z0-9?/.,;'`~!@#$%^&*()\-=+[\]{}\\|]["']/),
    ).toEqual([])
    expect(hits(/useHotkeys|hotkeys-js|mousetrap/i)).toEqual([])
  })

  it("2.3.1: no flashing content sources", () => {
    expect(architectural("2.3.1")?.evidence).toBe("architectural")
    expect(hits(/<canvas\b|<marquee\b|<blink\b/)).toEqual([])
    // Any infinite CSS animation must be one of the known slow indicators.
    const infinite = sources
      .filter((s) => s.file.endsWith(".css"))
      .flatMap((s) =>
        [...s.text.matchAll(/animation:\s*([^;]*infinite[^;]*);/g)].map(
          (m) => m[1],
        ),
      )
    for (const decl of infinite)
      expect(decl, "infinite animation").toMatch(/shimmer|spin|pulse/)
  })
})
