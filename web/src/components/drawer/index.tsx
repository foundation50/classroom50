// Barrel for the app sidebar/drawer. The pieces live in sibling files (context,
// class recipes, primitives, chrome, the role-aware menus, the account footer,
// and the per-context composers); this file preserves the original public
// surface so `@/components/drawer` importers are unchanged.
export { default } from "./collapseContext"
export { DrawerContent, DrawerToggle, DrawerSidebar } from "./DrawerChrome"
export { ClassroomLogo, AllClasses, SidebarClassInfo } from "./primitives"
export { StaffSidebarMenu } from "./StaffSidebarMenu"
export { SidebarFooter } from "./SidebarFooter"
export { MyClasses } from "./MyClasses"
export { MyOrgs } from "./MyOrgs"
export {
  SidebarContent,
  SidebarContentClasses,
  SidebarContentOrgs,
} from "./SidebarContent"
