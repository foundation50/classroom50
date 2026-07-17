import { useTranslation } from "react-i18next"

const Avatar = ({
  initials,
  name,
  github,
  subtitle,
  onClick,
}: {
  initials: string
  name: string
  github: string
  // Secondary line under the name (e.g. section badge or GitHub handle). Shown
  // only when set — no implicit handle fallback.
  subtitle?: React.ReactNode
  // When set, the avatar circle + name become a button opening details.
  onClick?: () => void
}) => {
  const { t } = useTranslation()
  const identity = (
    <>
      <div className="avatar avatar-placeholder">
        <div className="bg-base-200 text-primary rounded-full w-9">
          <span className="text-sm">
            {initials || github?.at(0)?.toUpperCase()}
          </span>
        </div>
      </div>

      <div className="min-w-0 flex-1 text-start">
        <div
          className={`font-medium text-base-content${onClick ? " group-hover/avatar:text-primary" : ""}`}
        >
          {name || github}
        </div>
        {subtitle ? (
          <div className="text-sm text-base-content/70">{subtitle}</div>
        ) : null}
      </div>
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        className="group/avatar flex items-center gap-3 cursor-pointer"
        onClick={onClick}
        title={t("components.avatar.viewDetails")}
      >
        {identity}
      </button>
    )
  }

  return <div className="flex items-center gap-3">{identity}</div>
}

export default Avatar
