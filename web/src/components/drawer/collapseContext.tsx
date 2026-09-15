import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { localStorageOrNull, setItemOrIgnore } from "@/lib/webStorage"

const SIDEBAR_COLLAPSED_KEY = "classroom50:sidebar-collapsed"
export const MOBILE_DRAWER_ID = "app-drawer"

type SidebarCollapseContextValue = {
  collapsed: boolean
  toggle: () => void
}

const SidebarCollapseContext = createContext<SidebarCollapseContextValue>({
  collapsed: false,
  toggle: () => {},
})

export const useSidebarCollapse = () => useContext(SidebarCollapseContext)

const Drawer = ({ children }: { children: ReactNode }) => {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorageOrNull()?.getItem(SIDEBAR_COLLAPSED_KEY) === "true"
  })

  useEffect(() => {
    setItemOrIgnore(
      localStorageOrNull(),
      SIDEBAR_COLLAPSED_KEY,
      String(collapsed),
    )
  }, [collapsed])

  return (
    <SidebarCollapseContext.Provider
      value={{ collapsed, toggle: () => setCollapsed((value) => !value) }}
    >
      <div className="drawer lg:drawer-open">{children}</div>
    </SidebarCollapseContext.Provider>
  )
}

export default Drawer
