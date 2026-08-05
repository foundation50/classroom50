/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GITHUB_CLIENT_ID?: string
  readonly VITE_GITHUB_PROXY_BASE?: string
  // Dev-only auto-login (see resolveDevAutoLoginPat). vite.config.ts blanks this
  // for any non-development build, so it can't reach a deployed bundle — but a
  // VITE_* value is inlined verbatim, so never set it for a production build.
  readonly VITE_GITHUB_PAT?: string
}

// Release identity injected at build time via Vite `define` (see vite.config.ts).
// Use the `appVersion` helper (src/version.ts), not these globals directly.
declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
declare const __APP_BUILD_DATE__: string

declare module "*.svg?react" {
  import * as React from "react"

  const ReactComponent: React.FC<React.SVGProps<SVGSVGElement>>

  export default ReactComponent
}
