// happy-dom >= 21 implements Element.animate(), but only partially (no
// Animation.commitStyles(), startTime stays null, ...). motion >= 14.7 composes
// an element's independent transforms (y, scale, ...) into one WAAPI animation
// and, under happy-dom, the toast exit stalls part-way through so AnimatePresence
// never unmounts it (NotificationProvider.test.tsx). motion detects WAAPI via
// `Element.prototype.hasOwnProperty("animate")`, so dropping it here sends every
// animation through motion's own frame loop, as before happy-dom 21. The
// Chromium project still exercises the real WAAPI path.
if (typeof Element !== "undefined") {
  Reflect.deleteProperty(Element.prototype, "animate")
}
