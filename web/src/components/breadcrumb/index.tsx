import useGetClassroom from "@/hooks/useGetClassroom"
import { useParams } from "@tanstack/react-router"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import { cx } from "@/components/ui"

const Breadcrumb = ({
  className,
  endpoint,
}: {
  className?: string
  endpoint: string
}) => {
  const { org, classroom, assignment } = useParams({ strict: false })
  const { data: classData } = useGetClassroom(org, classroom)
  const { t } = useTranslation()

  if (!org && !classroom) return <div></div>

  return (
    // Primer-style trail: no surface of its own — accent-blue links with the
    // current page in default ink, sitting directly on the canvas.
    <nav
      aria-label={t("components.breadcrumb.label")}
      className={cx(
        "breadcrumbs text-sm [&_a]:text-[var(--color-link)]",
        className,
      )}
    >
      <ol>
        {org && (
          <li>
            <Link to="/$org" params={{ org }}>
              {t("components.breadcrumb.classes")}
            </Link>
          </li>
        )}
        {org && classroom && (
          <li>
            <Link to="/$org/$classroom" params={{ org, classroom }}>
              {classData?.name || classData?.short_name || classroom}
            </Link>
          </li>
        )}
        {org && classroom && assignment && (
          <>
            <li>
              <Link
                to="/$org/$classroom/assignments"
                params={{ org, classroom }}
              >
                {t("components.breadcrumb.assignments")}
              </Link>
            </li>
            <li>
              <Link
                to="/$org/$classroom/assignments/$assignment"
                params={{ org, classroom, assignment }}
              >
                {assignment}
              </Link>
            </li>
          </>
        )}
        {endpoint && <li aria-current="page">{endpoint}</li>}
      </ol>
    </nav>
  )
}

export default Breadcrumb
