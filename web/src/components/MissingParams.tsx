import { useTranslation } from "react-i18next"

// Full-page bail when a route is missing an expected URL param; shared so the
// guard markup stays consistent. Callers may pass a context-specific message,
// else the translated generic one.
export const MissingParams = ({ message }: { message?: string }) => {
  const { t } = useTranslation()
  return (
    <div className="alert alert-error m-10" role="alert">
      {message ?? t("missingParams.message")}
    </div>
  )
}

export default MissingParams
