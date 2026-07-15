import { createLink, type LinkComponent } from "@tanstack/react-router"

import { Button, type ButtonProps } from "./Button"

// A TanStack Router link that wears the Button recipe — the single source for
// "a router link styled as a button" (View roster, Go home, etc.). Built via
// createLink so it keeps type-safe routing props (`to`, `params`, `search`,
// `preload`, active state) while reusing Button's variant/size/shape mapping,
// instead of hand-writing `<Link className="btn ...">` at each call site.
//
// Button already renders an <a> under `as="a"` (daisyUI styles anchors like
// buttons), so we force that here and let createLink own the href + navigation.
// A RouterButton never submits a form and needs no `type`; drop the button-only
// props that don't apply to an anchor.
type RouterButtonHostProps = Omit<
  ButtonProps,
  "as" | "href" | "type" | "ref" | "loading" | "loadingLabel"
>

const RouterButtonHost = (props: RouterButtonHostProps) => (
  <Button as="a" {...props} />
)

const CreatedRouterButton = createLink(RouterButtonHost)

// No default preload override — the app configures no defaultPreload, so plain
// <Link>s don't preload; matching that keeps this a purely cosmetic convergence
// (a caller can still opt in per-site via the standard `preload` prop).
export const RouterButton: LinkComponent<typeof RouterButtonHost> =
  CreatedRouterButton

export default RouterButton
