import { PublicWayBackItem } from "./PublicWayBackItem"

// The sidebar body on the public /privacy page: only the way back, so a
// signed-out visitor never sees org links that would bounce to sign-in.
export function PrivacySidebarNav() {
  return (
    <div className="py-4">
      <ul className="flex flex-col gap-1">
        <PublicWayBackItem groupId="privacy" />
      </ul>
    </div>
  )
}
