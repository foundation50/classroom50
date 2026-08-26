import { useEffect, useState } from "react"

// Returns true while `open` is true and for `ms` after it flips false, so
// content gated on an open flag can stay mounted through a dialog's close
// animation instead of vanishing mid-fade. `ms` tracks the DaisyUI modal
// transition (~200ms) with headroom.
export function useLingeringOpen(open: boolean, ms = 300): boolean {
  const [lingering, setLingering] = useState(open)
  // Render-phase adjustment (not an effect) so an open never paints unmounted.
  if (open && !lingering) setLingering(true)
  useEffect(() => {
    if (open) return
    const id = setTimeout(() => setLingering(false), ms)
    return () => clearTimeout(id)
  }, [open, ms])
  return open || lingering
}

export default useLingeringOpen
