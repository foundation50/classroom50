/// <reference types="vite/client" />

// Release identity injected at build time via Vite `define` (see
// vite.config.ts). Available anywhere in the app; use the `appVersion` helper
// (src/version.ts) rather than reading these globals directly.
declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
declare const __APP_BUILD_DATE__: string

declare module "*.svg?react" {
  import * as React from "react"

  const ReactComponent: React.FC<React.SVGProps<SVGSVGElement>>

  export default ReactComponent
}
