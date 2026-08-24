// The app's single icon seam: every icon is a Primer Octicon re-exported
// here, so a future swap or wrapper touches one file. Direct imports of the
// icon package (or lucide-react) are banned by `no-restricted-imports`.
export * from "@primer/octicons-react"

// Mirror a semantically-directional icon (back/forward arrows, drill-in
// chevrons) in RTL. Do not apply to non-directional icons (close X, checks,
// external-link, plus) or to purely rotational state chevrons unless their
// closed state points into the reading direction.
export const rtlFlip = "rtl:-scale-x-100"
