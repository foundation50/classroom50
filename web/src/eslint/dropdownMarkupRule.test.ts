// @vitest-environment node
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, it } from "vitest"
import { ESLint } from "eslint"
import {
  dropdownClassPattern,
  dropdownClassTemplateSelector,
  dropdownMarkupMessage,
} from "./dropdownMarkupRule"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const configPath = path.resolve(__dirname, "../../eslint.config.js")
const projectRoot = path.resolve(__dirname, "../..")

// Every menu goes through <Dropdown> (top-layer popover). Raw daisyUI dropdown
// markup is positioned inside its container and gets clipped or covered near
// an edge (#1026), so it is a lint ERROR, not an advisory warn.
describe("local/no-raw-dropdown", () => {
  const rawDropdownErrors = async (source: string) => {
    const eslint = new ESLint({
      cwd: projectRoot,
      overrideConfigFile: configPath,
    })
    const [result] = await eslint.lintText(source, {
      filePath: path.join(projectRoot, "src/pages/Probe.tsx"),
    })
    return result.messages.filter(
      (message) => message.ruleId === "local/no-raw-dropdown",
    )
  }

  const pattern = new RegExp(dropdownClassPattern)

  it.each([
    "dropdown",
    "dropdown dropdown-end",
    "dropdown-content menu",
    "lg:dropdown-open",
    "dropdown-bottom",
  ])("pattern matches a dropdown class token: %s", (cls) => {
    expect(pattern.test(cls)).toBe(true)
  })

  it.each(["menu", "btn dropdown_x", "dropdowns", "has-dropdown"])(
    "pattern ignores lookalike class: %s",
    (cls) => {
      expect(pattern.test(cls)).toBe(false)
    },
  )

  it("reports as an error, with the shared message", async () => {
    const source = `
      export function App() {
        return <div className="dropdown dropdown-end"><button>Go</button></div>
      }
    `
    const messages = await rawDropdownErrors(source)
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.every((m) => m.severity === 2)).toBe(true)
    expect(messages[0].message).toBe(dropdownMarkupMessage)
  })

  it("flags dropdown-content inside a cx() call", async () => {
    const source = `
      import { cx } from "@/components/ui"
      export function App({ wide }: { wide: boolean }) {
        return <ul className={cx("dropdown-content menu", wide && "w-64")} />
      }
    `
    expect(await rawDropdownErrors(source)).toHaveLength(1)
  })

  it("flags a dropdown class in a template-literal className chunk", async () => {
    const source = `
      export function App({ extra }: { extra: string }) {
        return <div className={\`dropdown \${extra}\`}>x</div>
      }
    `
    expect(await rawDropdownErrors(source)).toHaveLength(1)
    expect(dropdownClassTemplateSelector).toContain("TemplateElement")
  })

  it("flags a const recipe outside any className", async () => {
    const source = `
      const WRAPPER = "dropdown dropdown-end"
      export function App() {
        return <div className={WRAPPER}>x</div>
      }
    `
    expect(await rawDropdownErrors(source)).toHaveLength(1)
  })

  it("does not flag prose or a test name that mentions a dropdown", async () => {
    const source = `
      export const note = { text: "the dropdown opens inward" }
      it("dropdown closes on Escape", () => {})
    `
    expect(await rawDropdownErrors(source)).toHaveLength(0)
  })

  it("does not flag the shared primitives", async () => {
    const source = `
      import { Dropdown, DropdownMenu } from "@/components/ui"
      export function App() {
        return (
          <Dropdown align="end">
            <DropdownMenu.Trigger>Actions</DropdownMenu.Trigger>
            <DropdownMenu className="w-64 menu">
              <DropdownMenu.Item label="Go" onSelect={() => {}} />
            </DropdownMenu>
          </Dropdown>
        )
      }
    `
    expect(await rawDropdownErrors(source)).toHaveLength(0)
  })
})
