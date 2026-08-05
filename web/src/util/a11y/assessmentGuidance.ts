// Per-success-criterion assessor guidance for the dev-only WCAG assessment tool
// (the /assess page). A pure data leaf: the guidance is human-process prose (how
// to test each SC), separate from the conformance model (vpatModel owns the
// id/name/level/principle and the verdict). The interactive tool renders these
// bullets next to each outstanding criterion.

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
