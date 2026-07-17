// Mirror a semantically-directional icon (back/forward arrows, drill-in
// chevrons) in RTL. Do not apply to non-directional icons (close X, checks,
// external-link, plus) or to purely rotational state chevrons unless their
// closed state points into the reading direction.
export const rtlFlip = "rtl:-scale-x-100"
