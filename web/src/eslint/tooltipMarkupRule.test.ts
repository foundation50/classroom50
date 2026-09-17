// @vitest-environment node
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, it } from "vitest"
import { ESLint } from "eslint"
import {
  tooltipClassPattern,
  tooltipClassTemplateSelector,
  tooltipMarkupMessage,
} from "./tooltipMarkupRule"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const configPath = path.resolve(__dirname, "../../eslint.config.js")
const projectRoot = path.resolve(__dirname, "../..")

// Every hover bubble goes through <Tooltip> (top-layer popover). Raw daisyUI
// tooltip markup is positioned inside its container and gets clipped or
// covered near an edge (#1026), so it is a lint ERROR, not an advisory warn.
describe("local/no-raw-tooltip", () => {
  const rawTooltipErrors = async (source: string) => {
    const eslint = new ESLint({
      cwd: projectRoot,
      overrideConfigFile: configPath,
    })
    const [result] = await eslint.lintText(source, {
      filePath: path.join(projectRoot, "src/pages/Probe.tsx"),
    })
    return result.messages.filter(
      (message) => message.ruleId === "local/no-raw-tooltip",
    )
  }

  const pattern = new RegExp(tooltipClassPattern)

  it.each(["tooltip", "tooltip tooltip-right", "btn tooltip", "lg:tooltip"])(
    "pattern matches the base class token: %s",
    (cls) => {
      expect(pattern.test(cls)).toBe(true)
    },
  )

  it.each([
    "tooltip-bubble",
    "tooltip-warning",
    "tooltip-right",
    "cursor-help",
    "has-tooltip",
  ])("pattern ignores modifier/lookalike class: %s", (cls) => {
    expect(pattern.test(cls)).toBe(false)
  })

  it("reports as an error, with the shared message", async () => {
    const source = `
      export function App() {
        return <span className="tooltip" data-tip="Help">?</span>
      }
    `
    const messages = await rawTooltipErrors(source)
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.every((m) => m.severity === 2)).toBe(true)
    expect(messages[0].message).toBe(tooltipMarkupMessage)
  })

  it("flags a data-tip attribute on its own", async () => {
    const source = `
      export function App() {
        return <div data-tip="Help">?</div>
      }
    `
    expect(await rawTooltipErrors(source)).toHaveLength(1)
  })

  it("flags the tooltip class inside a cx() call", async () => {
    const source = `
      import { cx } from "@/components/ui"
      export function App({ open }: { open: boolean }) {
        return <span className={cx("tooltip tooltip-top", open && "tooltip-open")}>?</span>
      }
    `
    expect(await rawTooltipErrors(source)).toHaveLength(1)
  })

  it("flags the tooltip class in a template-literal className chunk", async () => {
    const source = `
      export function App({ extra }: { extra: string }) {
        return <span className={\`tooltip \${extra}\`}>?</span>
      }
    `
    expect(await rawTooltipErrors(source)).toHaveLength(1)
    expect(tooltipClassTemplateSelector).toContain("TemplateElement")
  })

  it("does not flag the shared Tooltip primitive or its bubble class", async () => {
    const source = `
      import { Tooltip, HelpTooltip } from "@/components/ui"
      export function App() {
        return (
          <div>
            <Tooltip tip="Help" tone="warning" className="cursor-help">?</Tooltip>
            <HelpTooltip help="More" />
            <div className="tooltip-bubble" popover="manual">x</div>
          </div>
        )
      }
    `
    expect(await rawTooltipErrors(source)).toHaveLength(0)
  })
})
