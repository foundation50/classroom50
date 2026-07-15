import { useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import { useOrgStaff } from "@/hooks/useOrgStaff"
import useGetClasses from "@/hooks/useGetClasses"

const OrgPage = () => {
  const { org } = useParams({ strict: false })
  const { isStaff, isNonStaff, roleResolved } = useOrgStaff(org)
  const { classes } = useGetClasses(org)
  const { t } = useTranslation()

  return (
    <div>
      <div>Is non-staff: {String(isNonStaff)}</div>
      <div>Is staff: {String(isStaff)}</div>
      <div>Role resolved: {String(roleResolved)}</div>
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
