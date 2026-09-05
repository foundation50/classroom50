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
    id: "1.3.3",
    bullets: [
      {
        label: "Supports means",
        text: 'no instruction relies only on shape, size, position, or sound (e.g. "the button on the right", "the green one").',
      },
      {
        label: "Visual",
        text: "read every instruction, empty state, and help text on the primary flows; each identifies its target by name, not by where it is or what it looks like.",
      },
    ],
  },
  {
    id: "1.3.4",
    bullets: [
      {
        label: "Supports means",
        text: "content works in both portrait and landscape; nothing locks the orientation.",
      },
      {
        label: "Visual",
        text: "in devtools, emulate a tablet in portrait and landscape on the organizations, assignments, and student accept pages; layout adapts and nothing is unreachable. Confirm no orientation lock in CSS or a manifest.",
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
    id: "1.4.1",
    bullets: [
      {
        label: "Supports means",
        text: "color is never the only way information is conveyed (status, errors, links, selection).",
      },
      {
        label: "Visual",
        text: "review status badges, submission/grade states, form errors, and the active sidebar item in grayscale (devtools rendering emulation: achromatopsia); each still has a text label, icon, or underline that carries the meaning.",
      },
    ],
  },
  {
    id: "1.4.5",
    bullets: [
      {
        label: "Supports means",
        text: "text is real text, not an image of text (logos are exempt).",
      },
      {
        label: "Visual / inspect",
        text: "check every <img> and background image on the primary flows; none renders words that could be real text. Org and user avatars and the logo are exempt.",
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
    id: "2.2.1",
    bullets: [
      {
        label: "Supports means",
        text: "any time limit can be turned off, adjusted, or extended, unless it is essential or over 20 hours.",
      },
      {
        label: "Keyboard + screen reader",
        text: "trigger a non-error toast (they auto-dismiss; errors persist): confirm the information is not lost when it disappears, or is available elsewhere on the page. Confirm the GitHub device-code expiry shows a way to request a new code. No other timeouts exist (the session is GitHub's, with no app-side idle logout).",
      },
    ],
  },
  {
    id: "2.2.2",
    bullets: [
      {
        label: "Supports means",
        text: "moving or auto-updating content that starts automatically and lasts over 5 seconds can be paused, stopped, or hidden, unless essential.",
      },
      {
        label: "Visual",
        text: "the only motion is loading spinners and the skeleton shimmer (progress indicators, which are exempt as essential) and short transitions. Confirm nothing else moves or auto-updates in parallel with content, and that prefers-reduced-motion and the in-app reduce-motion toggle stop the shimmer.",
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
    id: "2.4.2",
    bullets: [
      {
        label: "Supports means",
        text: "every page has a title that describes its topic or purpose (routes call useDocumentTitle).",
      },
      {
        label: "Screen reader",
        text: "navigate to each primary route (organizations, classroom, assignments, roster, submissions, student accept, settings, accessibility); the announced document title names the page and, where relevant, the org/classroom/assignment, and it changes on navigation.",
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
    id: "2.4.5",
    bullets: [
      {
        label: "Supports means",
        text: "more than one way exists to reach any page, unless it is a step in a process.",
      },
      {
        label: "Keyboard/visual",
        text: "for each teacher page, confirm at least two routes to it (sidebar nav plus breadcrumbs, cards, or in-page links). Student accept/submit pages are steps in a process (reached by invite link) and are exempt.",
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
    id: "2.5.1",
    bullets: [
      {
        label: "Supports means",
        text: "no function needs a multipoint or path-based gesture (pinch, swipe, draw) without a single-pointer alternative.",
      },
      {
        label: "Pointer",
        text: "on a touch device or devtools touch emulation, walk the primary flows; every action works with single taps. The roster/file dropzones accept a drag but also open a file picker on click.",
      },
    ],
  },
  {
    id: "2.5.2",
    bullets: [
      {
        label: "Supports means",
        text: "actions fire on pointer up (not down) and can be aborted by moving off the target before release.",
      },
      {
        label: "Pointer",
        text: "on buttons, menu items, table row actions, and the dropzones: press, drag off, release; nothing fires. Confirm no onMouseDown/onPointerDown handlers trigger actions.",
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
    id: "2.5.7",
    bullets: [
      {
        label: "Supports means",
        text: "anything operable by dragging also works with a single pointer without dragging.",
      },
      {
        label: "Pointer + keyboard",
        text: "the only drag interactions are the file dropzones (roster upload, FileDropzone). Confirm each also opens a native file picker on click and on Enter/Space, and that no list reorders or resizes by drag alone.",
      },
    ],
  },
  {
    id: "3.1.2",
    bullets: [
      {
        label: "Supports means",
        text: "any passage in a language other than the page language carries its own lang attribute (proper names and code are exempt).",
      },
      {
        label: "Inspect",
        text: 'switch the UI language and check for untranslated fixed strings (GitHub-owned terms like repository names and usernames are exempt). If an English fragment remains in a translated UI, it needs lang="en".',
      },
    ],
  },
  {
    id: "3.2.1",
    bullets: [
      {
        label: "Supports means",
        text: "merely focusing a control never triggers a change of context (navigation, new window, focus jump, form submit).",
      },
      {
        label: "Keyboard",
        text: "Tab through every control on the primary flows, including selects, comboboxes, and menu triggers; nothing opens, navigates, or submits until you activate it.",
      },
    ],
  },
  {
    id: "3.2.2",
    bullets: [
      {
        label: "Supports means",
        text: "changing a control's value never causes an unannounced change of context; if it does, the user is told beforehand.",
      },
      {
        label: "Keyboard",
        text: "change the sort/view/filter selects, the language and theme controls, and every form select or checkbox; the page updates in place without navigating away or moving focus unexpectedly. Auto-submit on change is a fail unless announced.",
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
    id: "3.2.6",
    bullets: [
      {
        label: "Supports means",
        text: "if a help mechanism (docs link, contact, feedback) repeats across pages, it appears in the same relative place on each.",
      },
      {
        label: "Visual",
        text: "the Docs link and About entry live in the sidebar footer; confirm their position is the same on every route that shows the sidebar, and that the student accept/submit pages either offer help in one consistent spot or none.",
      },
    ],
  },
  {
    id: "3.3.3",
    bullets: [
      {
        label: "Supports means",
        text: 'when an input error is detected and a fix is known, the message suggests it (e.g. the expected format), not just "invalid".',
      },
      {
        label: "Keyboard + screen reader",
        text: "submit each form with bad input (empty required field, malformed username/email, bad slug, roster file of the wrong shape); every error says what is wrong and how to fix it, and is announced.",
      },
    ],
  },
  {
    id: "3.3.4",
    bullets: [
      {
        label: "Supports means",
        text: "actions that delete or change user-controllable data are reversible, checked, or confirmed before commit.",
      },
      {
        label: "Keyboard",
        text: "walk each destructive action (unenroll students, delete/lock an assignment, remove a member, revoke a token, delete a group): a confirmation step names what will happen and requires an explicit confirm. Note which are reversible.",
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
