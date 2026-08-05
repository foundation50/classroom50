# Manual accessibility assessment — WCAG 2.2 AA

Committed assessor checklist for the WCAG 2.2 success criteria that automated
checks can't establish. These need a human keyboard + screen-reader pass; work
down each section and record the verdict in the VPAT model.

## How to record a result

Use the dev-only assessment tool — run `npm run dev` and open `/_assess` — to
click through each SC, pick a verdict, and enter a remark; it writes the verdict
to `web/src/util/vpatVerdicts.json` and regenerates this checklist. (You can also
edit `vpatVerdicts.json` by hand.) Each recorded verdict:

- sets `status` to `supports`, `partially`, or `doesNotSupport`;
- carries `evidence: "manual"`;
- has a specific, dated remark (what you tested + the outcome), e.g.
  `"2026-08-05 — VoiceOver/Safari + NVDA/Firefox: focus order on login, accept,
submit follows visual order; no traps. Supports."`;
- for any `partially` / `doesNotSupport`, open a tracked remediation follow-up.

After a session, ask the AI agent to standardize the remark wording in
`vpatVerdicts.json` into that dated format for consistency.

The VPAT integrity guard (`vpatGuard.test.ts`) enforces that a `supports` verdict
carries evidence, and the progress guard (`vpatManualAssessment.test.ts`) checks
this checklist stays in lockstep with the model's still-outstanding set — so a
verdict removes its section here automatically and a hand-edit that drifts fails
CI.

## Test matrix

- **Keyboard-only:** Tab / Shift+Tab / Enter / Space / arrow keys / Esc; no mouse.
- **Screen readers (minimum):** VoiceOver + Safari (macOS), NVDA + Firefox
  (Windows). JAWS is an open question (see plan `-004-`); add it if the committee
  requires it.
- **Primary flows to exercise each SC on:** login, accept assignment, submit,
  roster management, org settings.

---

## Perceivable

### 1.1.1 Non-text Content (A)

- **Supports means:** every informative image/icon has a text alternative; decorative ones are hidden from AT.
- **Keyboard:** n/a (content check).
- **Screen reader:** navigate images/icons on each flow; confirm meaningful alt text is announced and decorative graphics are silent (not "image").

### 1.3.1 Info and Relationships (A)

- **Supports means:** structure conveyed visually (headings, lists, form labels, tables) is programmatically determinable.
- **Keyboard:** tab through forms; confirm each field's label is associated.
- **Screen reader:** use rotor/element list for headings, lists, form fields; confirm relationships match the visual structure.

### 1.3.2 Meaningful Sequence (A)

- **Supports means:** reading/navigation order matches the meaningful visual order.
- **Keyboard:** Tab through each page; focus order follows the visual flow.
- **Screen reader:** read the page top-to-bottom; the announced sequence makes sense.

### 1.3.5 Identify Input Purpose (AA)

- **Supports means:** inputs collecting user info use appropriate `autocomplete` tokens.
- **Keyboard:** n/a.
- **Screen reader / inspect:** check login/profile inputs expose the correct input purpose (autocomplete).

### 1.4.13 Content on Hover or Focus (AA)

- **Supports means:** hover/focus content (tooltips) is dismissable (Esc), hoverable, and persistent until dismissed.
- **Keyboard:** focus a tooltip trigger (e.g. the help affordance in FormField); confirm the bubble shows, Esc dismisses it, and it doesn't vanish on pointer move into it.
- **Screen reader:** confirm the tooltip content is reachable/announced.

## Operable

### 2.1.1 Keyboard (A)

- **Supports means:** all functionality is operable by keyboard alone.
- **Keyboard:** complete each primary flow with no mouse — every control reachable and actuatable.
- **Screen reader:** n/a (keyboard check).

### 2.1.2 No Keyboard Trap (A)

- **Supports means:** focus can always move away from any component by keyboard.
- **Keyboard:** enter modals, menus, and the toast region; confirm Tab/Esc always escapes; focus returns to the trigger on modal close.

### 2.4.1 Bypass Blocks (A)

- **Supports means:** a mechanism (skip link / landmarks) bypasses repeated blocks.
- **Keyboard:** first Tab on a page reveals a "skip to main content" link that moves focus to main.
- **Screen reader:** confirm landmark navigation (main/nav) works via the rotor.

### 2.4.3 Focus Order (A)

- **Supports means:** focus order preserves meaning and operability.
- **Keyboard:** Tab through each flow; order is logical, no jumps that lose context.

### 2.4.4 Link Purpose (In Context) (A)

- **Supports means:** each link's purpose is clear from its text or context.
- **Screen reader:** list links via the rotor; each is distinguishable and purposeful (no bare "click here"/"link").

### 2.4.6 Headings and Labels (AA)

- **Supports means:** headings and labels describe topic or purpose.
- **Screen reader:** review the heading outline and form labels on each flow; they're descriptive and non-duplicative.

### 2.4.7 Focus Visible (AA)

- **Supports means:** the keyboard focus indicator is visible.
- **Keyboard:** Tab through every interactive element; a clear focus ring is always visible (including on the custom Button/Input primitives).

### 2.4.11 Focus Not Obscured (Minimum) (AA)

- **Supports means:** a focused element is not entirely hidden by sticky headers/overlays.
- **Keyboard:** Tab to elements near sticky UI (headers, banners, the toast region); the focused control stays at least partially visible.

### 2.5.3 Label in Name (A)

- **Supports means:** a control's accessible name contains its visible label text.
- **Screen reader:** for controls with visible text, confirm the announced name includes that text (matters for voice-control users).

## Understandable

### 3.2.3 Consistent Navigation (AA)

- **Supports means:** repeated navigation is in a consistent relative order across pages.
- **Keyboard/visual:** the nav/drawer order is consistent across routes.

### 3.2.4 Consistent Identification (AA)

- **Supports means:** components with the same function are identified consistently.
- **Screen reader:** the same action (e.g. "Sign out", icon buttons) has a consistent accessible name across the app.

### 3.3.7 Redundant Entry (A)

- **Supports means:** info already entered is auto-populated or available, not re-asked in the same process.
- **Keyboard:** step through multi-step flows (e.g. classroom/assignment creation); previously entered data isn't needlessly re-requested.

### 3.3.8 Accessible Authentication (Minimum) (AA)

- **Supports means:** no cognitive-function test (e.g. remembering/transcribing) without an alternative; auth is delegated to GitHub OAuth/device-code.
- **Keyboard + screen reader:** complete sign-in via the device-code/OAuth flow using keyboard + AT; confirm no app-imposed cognitive test and the flow is announced.

## Robust

### 4.1.2 Name, Role, Value (A)

- **Supports means:** every UI component exposes a correct name, role, and state to AT.
- **Screen reader:** for buttons, links, inputs, menus, modals, tabs on each flow, confirm the announced role + name + state (expanded/checked/invalid) is correct and updates on interaction.
