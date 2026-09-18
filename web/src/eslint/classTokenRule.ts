import type { Rule } from "eslint"

// Shared shape of the "no raw class token" lint rules (tooltip, dropdown,
// radius): one regex over class-list strings, matched wherever a className can
// come from.
//
// A class token matches at start-of-string, after whitespace, or after a
// variant colon (`lg:tooltip`), and ends where the token ends; a rule's
// pattern spells out what may follow so lookalikes (`tooltip-bubble`,
// `rounded-full`) stay allowed.

export type ClassTokenScope =
  // Only `className` JSX attributes (including cx() calls and template chunks
  // inside them).
  | "className"
  // Also `const RECIPE = "..."` initializers and any cx() argument, so a recipe
  // parked in a constant and passed as `className={RECIPE}` cannot slip past.
  // Not every string: prose in call arguments, object values, and JSX text
  // stays out. A bare string constant is matched whatever it holds (a
  // recipe's name gives nothing to key on), so prose that mentions the token
  // belongs in a call or object, not a top-level `const`.
  | "classSources"

const CLASS_NAME_ROOT = "JSXAttribute[name.name='className']"
const CX_CALL_ROOT = "CallExpression[callee.name='cx']"

// esquery selectors for a pattern, one per node kind a class string can be:
// a Literal, or the static chunks (TemplateElement) of a template literal.
export function classTokenSelectors(
  pattern: string,
  scope: ClassTokenScope,
): { literal: string; template: string; extra: string[] } {
  const literal = `Literal[value=/${pattern}/]`
  const template = `TemplateElement[value.raw=/${pattern}/]`
  const extra =
    scope === "classSources"
      ? [
          `VariableDeclarator > ${literal}`,
          `VariableDeclarator > TemplateLiteral > ${template}`,
          `${CX_CALL_ROOT} ${literal}`,
          `${CX_CALL_ROOT} ${template}`,
        ]
      : []
  return {
    literal: `${CLASS_NAME_ROOT} ${literal}`,
    template: `${CLASS_NAME_ROOT} ${template}`,
    extra,
  }
}

export function classTokenRule({
  pattern,
  scope,
  description,
  messageId,
  message,
  extraSelectors = [],
}: {
  pattern: string
  scope: ClassTokenScope
  description: string
  messageId: string
  message: string
  // Further esquery selectors to report with the same message (an attribute
  // that only the raw recipe uses, e.g. `data-tip`).
  extraSelectors?: string[]
}): Rule.RuleModule {
  const { literal, template, extra } = classTokenSelectors(pattern, scope)
  return {
    meta: {
      type: "problem",
      docs: { description },
      schema: [],
      messages: { [messageId]: message },
    },
    create(context) {
      // One node may match several selectors (a cx() literal inside a
      // className); report it once.
      const reported = new WeakSet<Rule.Node>()
      const report = (node: Rule.Node) => {
        if (reported.has(node)) return
        reported.add(node)
        context.report({ node, messageId })
      }
      return Object.fromEntries(
        [literal, template, ...extra, ...extraSelectors].map((selector) => [
          selector,
          report,
        ]),
      )
    },
  }
}
