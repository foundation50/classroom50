import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"

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
    if (typeof window === "undefined") return false
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"
  })

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
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
