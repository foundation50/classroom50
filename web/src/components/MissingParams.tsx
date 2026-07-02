import { useTranslation } from "react-i18next"

// Full-page bail when a route is missing an expected URL param. Shared so the
// guard markup stays consistent across pages. Callers may pass a context-specific
// message; when omitted it falls back to the translated generic message.
export const MissingParams = ({ message }: { message?: string }) => {
  const { t } = useTranslation()
  return (
    <div className="alert alert-error m-10" role="alert">
      {message ?? t("missingParams.message")}
    </div>
  )
}

export default MissingParams
