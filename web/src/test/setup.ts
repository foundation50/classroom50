// happy-dom >= 21 implements Element.animate(), so motion drives Web Animations
// in the node suite. Its Animation.cancel() rejects `finished` without marking
// the promise handled, which the Web Animations spec requires and browsers do;
// vitest then reports every cancelled animation as an unhandled rejection.
// Attach the no-op handler ourselves until capricorn86/happy-dom#2412 ships.
if (typeof Animation !== "undefined") {
  const cancel = Animation.prototype.cancel
  Animation.prototype.cancel = function (this: Animation) {
    this.finished.catch(() => {})
    cancel.call(this)
  }
}
