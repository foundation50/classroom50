// @vitest-environment node
import path from "path"
import directionalClassProbes from "./directionalClassProbes.json"
import { fileURLToPath } from "url"
import { describe, expect, it } from "vitest"
import { ESLint } from "eslint"
import { buttonFormSelector, buttonFormMessage } from "./buttonFormRule"
import {
  directionalClassPattern,
  directionalClassMessage,
} from "./directionalClassRule"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const configPath = path.resolve(__dirname, "../../eslint.config.js")
const projectRoot = path.resolve(__dirname, "../..")

const BUTTON_FORM_SELECTOR = buttonFormSelector
const BUTTON_FORM_MESSAGE = buttonFormMessage

async function lintMessageCount(source: string) {
  const eslint = new ESLint({
    cwd: projectRoot,
    overrideConfigFile: configPath,
  })
  const [result] = await eslint.lintText(source, {
    filePath: path.join(projectRoot, "Button.test.tsx"),
  })
  return result.messages.filter(
    (message) =>
      message.ruleId === "no-restricted-syntax" &&
      message.message === BUTTON_FORM_MESSAGE,
  ).length
}

describe("no-restricted-syntax <Button> form guard", () => {
  // The selector and message are sourced from a shared module; importing
  // those values into the ESLint config and this test prevents accidental
  // drift between the rule and its tests.

  it("keeps the shared button form selector wired to the expected Button pattern", () => {
    expect(BUTTON_FORM_SELECTOR).toContain(
      "JSXOpeningElement[name.name='Button']",
    )
    expect(BUTTON_FORM_SELECTOR).toContain("type|as|href")
  })

  it("warns for a typeless <Button> inside a <form>", async () => {
    const source = `
      import { Button } from "./Button"
      export function App() {
        return <form><Button>Go</Button></form>
      }
    `
    expect(await lintMessageCount(source)).toBe(1)
  })

  it('warns for a typeless <Button> inside <Card as="form">', async () => {
    const source = `
      import { Button } from "./Button"
      import { Card } from "./Card"
      export function App() {
        return <Card as="form"><Button>Go</Button></Card>
      }
    `
    expect(await lintMessageCount(source)).toBe(1)
  })

  it("warns for a nested typeless <Button> inside a <form>", async () => {
    const source = `
      import { Button } from "./Button"
      export function App() {
        return <form><div><Button>Go</Button></div></form>
      }
    `
    expect(await lintMessageCount(source)).toBe(1)
  })

  it("warns for a typeless <Button> wrapping a typed child", async () => {
    const source = `
      import { Button } from "./Button"
      export function App() {
        return (
          <form>
            <Button><input type="text" /></Button>
          </form>
        )
      }
    `
    expect(await lintMessageCount(source)).toBe(1)
  })

  it("warns for a typeless <Button> inside a <form> with a non-safe attr", async () => {
    const source = `
      import { Button } from "./Button"
      export function App() {
        return <form><Button onClick={save}>Save</Button></form>
      }
    `
    expect(await lintMessageCount(source)).toBe(1)
  })

  it("warns for a typeless <Button> inside a <form> with a look-alike attr", async () => {
    const source = `
      import { Button } from "./Button"
      export function App() {
        return <form><Button data-type="x">Go</Button></form>
      }
    `
    expect(await lintMessageCount(source)).toBe(1)
  })

  it("warns for a <Button> with a variant prop inside a <form>", async () => {
    const source = `
      import { Button } from "./Button"
      export function App() {
        return <form><Button variant="primary">Go</Button></form>
      }
    `
    expect(await lintMessageCount(source)).toBe(1)
  })

  it("warns for a <Button> with a className prop inside a <form>", async () => {
    const source = `
      import { Button } from "./Button"
      export function App() {
        return <form><Button className="x">Go</Button></form>
      }
    `
    expect(await lintMessageCount(source)).toBe(1)
  })

  it("does not warn for a <Button> with explicit type inside a <form>", async () => {
    const source = `
      import { Button } from "./Button"
      export function App() {
        return <form><Button type="submit">Go</Button></form>
      }
    `
    expect(await lintMessageCount(source)).toBe(0)
  })

  it("does not warn for a <Button> with explicit href inside a <form>", async () => {
    const source = `
      import { Button } from "./Button"
      export function App() {
        return <form><Button href="/">Go</Button></form>
      }
    `
    expect(await lintMessageCount(source)).toBe(0)
  })

  it.each([
    `<Button type="button">Go</Button>`,
    `<Button as="a" href="/">Go</Button>`,
    `<Card as="div"><Button>Go</Button></Card>`,
    `<form><Button as="div">Go</Button></form>`,
    `<Button>Go</Button>`,
    `<Button type="submit" onClick={h} className="x">Go</Button>`,
  ])("does not warn for safe button shapes: %s", async (jsx) => {
    const source = `
      import { Button } from "./Button"
      import { Card } from "./Card"
      export function App() {
        return <div>${jsx}</div>
      }
    `
    expect(await lintMessageCount(source)).toBe(0)
  })
})

async function directionalWarningCount(source: string) {
  const eslint = new ESLint({
    cwd: projectRoot,
    overrideConfigFile: configPath,
  })
  const [result] = await eslint.lintText(source, {
    filePath: path.join(projectRoot, "Directional.test.tsx"),
  })
  return result.messages.filter(
    (message) =>
      message.ruleId === "no-restricted-syntax" &&
      message.message === directionalClassMessage,
  ).length
}

describe("no-restricted-syntax physical directional class guard", () => {
  // The pattern is shared between the config and audit_i18n.py's Python
  // backstop; the regex-level cases here pin the exact token boundaries so a
  // tweak can't silently widen (flagging logical classes) or narrow (missing
  // physical ones) the net.
  const pattern = new RegExp(directionalClassPattern)

  it.each([
    "ml-2",
    "-mr-1",
    "hover:pl-4",
    "pr-8",
    "text-left",
    "text-right",
    "border-l-2",
    "left-3",
    "right-0",
    "left-[3px]",
    "left-full",
    "right-px",
    "rounded-l-md",
    "rounded-tr-lg",
    "sm:right-4",
    "scroll-ml-4",
  ])("pattern matches physical class: %s", (cls) => {
    expect(pattern.test(cls)).toBe(true)
  })

  it.each([
    "ms-2",
    "me-auto",
    "ps-5",
    "pe-4",
    "text-start",
    "text-end",
    "border-s-2",
    "border-t-2",
    "start-2",
    "end-3",
    "rounded-lg",
    "rounded-t-lg",
    "translate-x-0.5",
    "rtl:-translate-x-0.5",
    "space-x-3",
    "inset-x-0",
    "blur-sm",
    "flex-1",
    "tooltip-right",
    "rtl:tooltip-left",
    "col-start-2",
    "justify-start",
  ])("pattern ignores logical/lookalike class: %s", (cls) => {
    expect(pattern.test(cls)).toBe(false)
  })

  // Cross-language parity: the same probe fixture is asserted against
  // PHYSICAL_CLASS_RE in test_audit_i18n.py. If either pattern changes without
  // the fixture (and therefore the other pattern), one of the two suites fails
  // — the sync is a tested contract, not a comment.
  describe("shared probe fixture (parity with audit_i18n.py)", () => {
    it.each(directionalClassProbes.matches)(
      "fixture match probe: %s",
      (cls) => {
        expect(pattern.test(cls)).toBe(true)
      },
    )

    it.each(directionalClassProbes.nonMatches)(
      "fixture non-match probe: %s",
      (cls) => {
        expect(pattern.test(cls)).toBe(false)
      },
    )
  })

  it("warns for a physical class in a className string literal", async () => {
    const source = `
      export function App() {
        return <div className="flex ml-2">x</div>
      }
    `
    expect(await directionalWarningCount(source)).toBe(1)
  })

  it("warns for a physical class in a template-literal className chunk", async () => {
    const source = `
      export function App({ active }: { active: boolean }) {
        return <div className={\`pl-4 \${active ? "font-bold" : ""}\`}>x</div>
      }
    `
    expect(await directionalWarningCount(source)).toBe(1)
  })

  it("does not warn for logical classes in either className form", async () => {
    const source = `
      export function App({ active }: { active: boolean }) {
        return (
          <div className="flex ms-2 text-start border-s-2">
            <span className={\`ps-4 end-3 \${active ? "font-bold" : ""}\`}>x</span>
          </div>
        )
      }
    `
    expect(await directionalWarningCount(source)).toBe(0)
  })

  it("does not warn for rtl-paired physical-only utilities", async () => {
    const source = `
      export function App() {
        return <div className="ltr:group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5 tooltip-right rtl:tooltip-left">x</div>
      }
    `
    expect(await directionalWarningCount(source)).toBe(0)
  })
})
