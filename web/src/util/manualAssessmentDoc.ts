// Renders the committed manual-assessment checklist (accessibility/
// manual-assessment.md) from data, so the doc and the dev-only assessment tool
// (see vite.config.ts) share one source of guidance. A pure leaf: data + string
// building only, reading criterion metadata from vpatModel.
//
// The rendered body lists exactly the still-outstanding SCs (hasGenericRemark),
// grouped by principle. As a human records a verdict in vpatVerdicts.json that
// SC drops out of the outstanding set and out of this doc automatically, so the
// checklist never drifts from the model. manualAssessmentDoc.test.ts asserts the
// committed markdown equals this renderer's output (a "generated file is fresh"
// guard, like the contrast/VPAT renderers).

import {
  CRITERIA,
  hasGenericRemark,
  PRINCIPLE_ORDER,
  type Criterion,
} from "./vpatModel"

/** One assessor guidance bullet: a bold lead-in label and its instruction. */
export type GuidanceBullet = { label: string; text: string }

/** Per-SC assessor guidance keyed by WCAG SC id. */
export type Guidance = { id: string; bullets: GuidanceBullet[] }

// Assessor guidance for every manually-assessed SC. Kept here (not in the model)
// because it is human-process prose, not conformance data; the model owns the
// id/name/level/principle and the verdict.
export const ASSESSMENT_GUIDANCE: Guidance[] = [
  {
    id: "1.1.1",
    bullets: [
      {
        label: "Supports means",
        text: "every informative image/icon has a text alternative; decorative ones are hidden from AT.",
      },
      { label: "Keyboard", text: "n/a (content check)." },
      {
        label: "Screen reader",
        text: 'navigate images/icons on each flow; confirm meaningful alt text is announced and decorative graphics are silent (not "image").',
      },
    ],
  },
  {
    id: "1.3.1",
    bullets: [
      {
        label: "Supports means",
        text: "structure conveyed visually (headings, lists, form labels, tables) is programmatically determinable.",
      },
      {
        label: "Keyboard",
        text: "tab through forms; confirm each field's label is associated.",
      },
      {
        label: "Screen reader",
        text: "use rotor/element list for headings, lists, form fields; confirm relationships match the visual structure.",
      },
    ],
  },
  {
    id: "1.3.2",
    bullets: [
      {
        label: "Supports means",
        text: "reading/navigation order matches the meaningful visual order.",
      },
      {
        label: "Keyboard",
        text: "Tab through each page; focus order follows the visual flow.",
      },
      {
        label: "Screen reader",
        text: "read the page top-to-bottom; the announced sequence makes sense.",
      },
    ],
  },
  {
    id: "1.3.5",
    bullets: [
      {
        label: "Supports means",
        text: "inputs collecting user info use appropriate `autocomplete` tokens.",
      },
      { label: "Keyboard", text: "n/a." },
      {
        label: "Screen reader / inspect",
        text: "check login/profile inputs expose the correct input purpose (autocomplete).",
      },
    ],
  },
  {
    id: "1.4.13",
    bullets: [
      {
        label: "Supports means",
        text: "hover/focus content (tooltips) is dismissable (Esc), hoverable, and persistent until dismissed.",
      },
      {
        label: "Keyboard",
        text: "focus a tooltip trigger (e.g. the help affordance in FormField); confirm the bubble shows, Esc dismisses it, and it doesn't vanish on pointer move into it.",
      },
      {
        label: "Screen reader",
        text: "confirm the tooltip content is reachable/announced.",
      },
    ],
  },
  {
    id: "2.1.1",
    bullets: [
      {
        label: "Supports means",
        text: "all functionality is operable by keyboard alone.",
      },
      {
        label: "Keyboard",
        text: "complete each primary flow with no mouse — every control reachable and actuatable.",
      },
      { label: "Screen reader", text: "n/a (keyboard check)." },
    ],
  },
  {
    id: "2.1.2",
    bullets: [
      {
        label: "Supports means",
        text: "focus can always move away from any component by keyboard.",
      },
      {
        label: "Keyboard",
        text: "enter modals, menus, and the toast region; confirm Tab/Esc always escapes; focus returns to the trigger on modal close.",
      },
    ],
  },
  {
    id: "2.4.1",
    bullets: [
      {
        label: "Supports means",
        text: "a mechanism (skip link / landmarks) bypasses repeated blocks.",
      },
      {
        label: "Keyboard",
        text: 'first Tab on a page reveals a "skip to main content" link that moves focus to main.',
      },
      {
        label: "Screen reader",
        text: "confirm landmark navigation (main/nav) works via the rotor.",
      },
    ],
  },
  {
    id: "2.4.3",
    bullets: [
      {
        label: "Supports means",
        text: "focus order preserves meaning and operability.",
      },
      {
        label: "Keyboard",
        text: "Tab through each flow; order is logical, no jumps that lose context.",
      },
    ],
  },
  {
    id: "2.4.4",
    bullets: [
      {
        label: "Supports means",
        text: "each link's purpose is clear from its text or context.",
      },
      {
        label: "Screen reader",
        text: 'list links via the rotor; each is distinguishable and purposeful (no bare "click here"/"link").',
      },
    ],
  },
  {
    id: "2.4.6",
    bullets: [
      {
        label: "Supports means",
        text: "headings and labels describe topic or purpose.",
      },
      {
        label: "Screen reader",
        text: "review the heading outline and form labels on each flow; they're descriptive and non-duplicative.",
      },
    ],
  },
  {
    id: "2.4.7",
    bullets: [
      {
        label: "Supports means",
        text: "the keyboard focus indicator is visible.",
      },
      {
        label: "Keyboard",
        text: "Tab through every interactive element; a clear focus ring is always visible (including on the custom Button/Input primitives).",
      },
    ],
  },
  {
    id: "2.4.11",
    bullets: [
      {
        label: "Supports means",
        text: "a focused element is not entirely hidden by sticky headers/overlays.",
      },
      {
        label: "Keyboard",
        text: "Tab to elements near sticky UI (headers, banners, the toast region); the focused control stays at least partially visible.",
      },
    ],
  },
  {
    id: "2.5.3",
    bullets: [
      {
        label: "Supports means",
        text: "a control's accessible name contains its visible label text.",
      },
      {
        label: "Screen reader",
        text: "for controls with visible text, confirm the announced name includes that text (matters for voice-control users).",
      },
    ],
  },
  {
    id: "3.2.3",
    bullets: [
      {
        label: "Supports means",
        text: "repeated navigation is in a consistent relative order across pages.",
      },
      {
        label: "Keyboard/visual",
        text: "the nav/drawer order is consistent across routes.",
      },
    ],
  },
  {
    id: "3.2.4",
    bullets: [
      {
        label: "Supports means",
        text: "components with the same function are identified consistently.",
      },
      {
        label: "Screen reader",
        text: 'the same action (e.g. "Sign out", icon buttons) has a consistent accessible name across the app.',
      },
    ],
  },
  {
    id: "3.3.7",
    bullets: [
      {
        label: "Supports means",
        text: "info already entered is auto-populated or available, not re-asked in the same process.",
      },
      {
        label: "Keyboard",
        text: "step through multi-step flows (e.g. classroom/assignment creation); previously entered data isn't needlessly re-requested.",
      },
    ],
  },
  {
    id: "3.3.8",
    bullets: [
      {
        label: "Supports means",
        text: "no cognitive-function test (e.g. remembering/transcribing) without an alternative; auth is delegated to GitHub OAuth/device-code.",
      },
      {
        label: "Keyboard + screen reader",
        text: "complete sign-in via the device-code/OAuth flow using keyboard + AT; confirm no app-imposed cognitive test and the flow is announced.",
      },
    ],
  },
  {
    id: "4.1.2",
    bullets: [
      {
        label: "Supports means",
        text: "every UI component exposes a correct name, role, and state to AT.",
      },
      {
        label: "Screen reader",
        text: "for buttons, links, inputs, menus, modals, tabs on each flow, confirm the announced role + name + state (expanded/checked/invalid) is correct and updates on interaction.",
      },
    ],
  },
]

const GUIDANCE_BY_ID = new Map(ASSESSMENT_GUIDANCE.map((g) => [g.id, g]))

/** The still-outstanding criteria a human must assess, in model order. */
export function outstandingCriteria(criteria: Criterion[] = CRITERIA) {
  return criteria.filter(hasGenericRemark)
}

const HEADER = `# Manual accessibility assessment — WCAG 2.2 AA

Committed assessor checklist for the WCAG 2.2 success criteria that automated
checks can't establish. These need a human keyboard + screen-reader pass; work
down each section and record the verdict in the VPAT model.

## How to record a result

Use the dev-only assessment tool — run \`npm run dev\` and open \`/assess\` — to
click through each SC, pick a verdict, and enter a remark; it writes the verdict
to \`web/src/util/vpatVerdicts.json\` and regenerates this checklist. (You can also
edit \`vpatVerdicts.json\` by hand.) Each recorded verdict:

- sets \`status\` to \`supports\`, \`partially\`, or \`doesNotSupport\`;
- carries \`evidence: "manual"\`;
- has a specific, dated remark (what you tested + the outcome), e.g.
  \`"2026-08-05 — VoiceOver/Safari + NVDA/Firefox: focus order on login, accept,
submit follows visual order; no traps. Supports."\`;
- for any \`partially\` / \`doesNotSupport\`, open a tracked remediation follow-up.

After a session, ask the AI agent to standardize the remark wording in
\`vpatVerdicts.json\` into that dated format for consistency.

The VPAT integrity guard (\`vpatGuard.test.ts\`) enforces that a \`supports\` verdict
carries evidence, and the progress guard (\`vpatManualAssessment.test.ts\`) checks
this checklist stays in lockstep with the model's still-outstanding set — so a
verdict removes its section here automatically and a hand-edit that drifts fails
CI.

## Test matrix

- **Keyboard-only:** Tab / Shift+Tab / Enter / Space / arrow keys / Esc; no mouse.
- **Screen readers (minimum):** VoiceOver + Safari (macOS), NVDA + Firefox
  (Windows). JAWS is an open question (see plan \`-004-\`); add it if the committee
  requires it.
- **Primary flows to exercise each SC on:** login, accept assignment, submit,
  roster management, org settings.

---
`

/**
 * Render the checklist markdown from the model's outstanding set + guidance. The
 * output is what accessibility/manual-assessment.md must contain; the freshness
 * test compares them byte-for-byte.
 */
export function renderManualAssessment(
  criteria: Criterion[] = CRITERIA,
): string {
  const outstanding = outstandingCriteria(criteria)
  const lines: string[] = [HEADER]
  for (const principle of PRINCIPLE_ORDER) {
    const inPrinciple = outstanding.filter((c) => c.principle === principle)
    if (inPrinciple.length === 0) continue
    lines.push(`## ${principle}\n`)
    for (const c of inPrinciple) {
      lines.push(`### ${c.id} ${c.name} (${c.level})\n`)
      const guidance = GUIDANCE_BY_ID.get(c.id)
      if (!guidance) {
        throw new Error(
          `No assessor guidance for outstanding criterion ${c.id}.`,
        )
      }
      for (const b of guidance.bullets) {
        lines.push(`- **${b.label}:** ${b.text}`)
      }
      lines.push("")
    }
  }
  return lines.join("\n").trimEnd() + "\n"
}
