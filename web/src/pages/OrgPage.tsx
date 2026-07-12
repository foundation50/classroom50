import { useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import { useConfigRepoAccess } from "@/hooks/useConfigRepoAccess"
import useGetClasses from "@/hooks/useGetClasses"

const OrgPage = () => {
  const { org } = useParams({ strict: false })
  const { isTeacher, isStudent, isBlocked } = useConfigRepoAccess(org)
  const { classes } = useGetClasses(org)
  const { t } = useTranslation()

  return (
    <div>
      <div>Is student: {String(isStudent)}</div>
      <div>Is teacher: {String(isTeacher)}</div>
      <div>Is blocked: {String(isBlocked)}</div>
      <hr />

      <div>
        <h3>{t("documentTitle.classes")}</h3>
        <ul>
          {classes.map((cl) => (
            <li key={cl.name}>{cl.name}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export default OrgPage
