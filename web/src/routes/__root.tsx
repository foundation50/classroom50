import {
  createRootRouteWithContext,
  Outlet,
  useParams,
} from "@tanstack/react-router"
import type { RouterContext } from "@/types/router"
import { TriangleAlert } from "lucide-react"
import { useTranslation } from "react-i18next"
import { RoleViewProvider } from "@/context/roleView/RoleViewProvider"

const RootComponent = () => {
  // Scope "view as" to the current org (reset across orgs via the key); the
  // provider re-syncs on classroom change. Reading params at the root keeps the
  // provider inside the router.
  const { org, classroom } = useParams({ strict: false })
  return (
    <RoleViewProvider key={org ?? "no-org"} org={org} classroom={classroom}>
      <Outlet />
    </RoleViewProvider>
  )
}

// App-wide safety net: any uncaught render error in a route subtree degrades to
// this screen instead of a blank white page.
const RootErrorComponent = ({ error }: { error: Error }) => {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-10 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-error/10 text-error">
        <TriangleAlert aria-hidden="true" className="size-8" />
      </div>
      <div>
        <h1 className="text-2xl font-bold">{t("error.title")}</h1>
        <p className="mt-1 max-w-md text-base-content/70">
          {error?.message || t("error.unexpected")}
        </p>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => window.location.reload()}
      >
        {t("error.reload")}
      </button>
    </div>
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  errorComponent: RootErrorComponent,
})
