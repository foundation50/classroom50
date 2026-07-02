import { useEffect } from "react"
import { RouterProvider } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import router from "./router"
import { Spinner } from "@/components/Spinner"
import { useGithubAuth } from "@/auth/useGithubAuth"

export function App() {
  const { status, token, user } = useGithubAuth()
  const { t } = useTranslation()

  useEffect(() => {
    if (status === "loading") return
    void router.invalidate()
  }, [status, token])

  if (status === "loading") {
    return (
      <div className="min-h-screen grid place-items-center">
        <Spinner size="lg" label={t("common.loadingApp")} />
      </div>
    )
  }

  return <RouterProvider router={router} context={{ auth: { user, status } }} />
}

export default App
