import type { Transition, Variants } from "motion/react"

// Shared motion primitives mirroring the CSS token values in index.css
// (durations 100/150/200ms, ease-out) so JS and CSS motion stay consistent.
// Every consumer pairs with MotionConfig reducedMotion="user", so these need no
// reduced-motion guard.

export const DURATION = {
  fast: 0.1,
  base: 0.15,
  slow: 0.2,
} as const

// Standard ease-out curve, matching the `--ease-out-soft` token in index.css.
export const EASE_OUT: Transition["ease"] = [0, 0, 0.2, 1]

// Staggered entrance for a list of cards: delay is index * 60ms, capped so a
// long list doesn't leave later items waiting. Pair with `enterExit`.
export const staggerTransition = (index: number): Transition => ({
  duration: DURATION.slow,
  ease: EASE_OUT,
  delay: Math.min(index, 8) * 0.06,
})

export const enterExit: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: {
    opacity: 1,
    scale: 1,
    transition: { duration: DURATION.slow, ease: EASE_OUT },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    transition: { duration: DURATION.base, ease: EASE_OUT },
  },
}

// Entrance for notice/alert callouts that appear after an async check and push
// content down: a gentle slide-down + fade, distinct from the card scale-up so a
// "notice arrived" reads differently.
export const calloutVariants: Variants = {
  initial: { opacity: 0, y: -8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: DURATION.slow, ease: EASE_OUT },
  },
  exit: {
    opacity: 0,
    y: -8,
    transition: { duration: DURATION.base, ease: EASE_OUT },
  },
}

// Hover affordance for clickable list rows: a subtle lift + shadow (the former
// `clickable-row` CSS utility). Pair with a `bg` hover via className.
export const rowHover = {
  whileHover: { y: -1, boxShadow: "0 1px 3px rgb(0 0 0 / 0.08)" },
  transition: { duration: DURATION.base, ease: EASE_OUT },
} as const

// Toasts slide up from the bottom as they enter and drop back down on exit.
export const toastVariants: Variants = {
  initial: { opacity: 0, y: 12, scale: 0.98 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: DURATION.base, ease: EASE_OUT },
  },
  exit: {
    opacity: 0,
    y: 8,
    scale: 0.98,
    transition: { duration: DURATION.fast, ease: EASE_OUT },
  },
}

// Collapse height as well as fade, so a dismissed alert doesn't leave a gap
// while it animates out.
export const collapseVariants: Variants = {
  initial: { opacity: 0, height: 0 },
  animate: {
    opacity: 1,
    height: "auto",
    transition: { duration: DURATION.base, ease: EASE_OUT },
  },
  exit: {
    opacity: 0,
    height: 0,
    transition: { duration: DURATION.base, ease: EASE_OUT },
  },
}

// Short cross-fade for swapping loading skeletons with resolved content
// (LoadingSwap). Fast so the app never feels sluggish.
export const crossFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DURATION.base } },
  exit: { opacity: 0, transition: { duration: DURATION.fast } },
}
