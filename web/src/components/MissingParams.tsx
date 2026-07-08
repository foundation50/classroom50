import { useTranslation } from "react-i18next"

import { Alert } from "@/components/ui"

// Full-page bail when a route is missing an expected URL param; shared so the
// guard markup stays consistent. Callers may pass a context-specific message,
// else the translated generic one.
export const MissingParams = ({ message }: { message?: string }) => {
  const { t } = useTranslation()
  return (
    <Alert tone="error" className="m-10">
      {message ?? t("missingParams.message")}
    </Alert>
  )
}

export default MissingParams
