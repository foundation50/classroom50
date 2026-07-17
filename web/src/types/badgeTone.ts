// The semantic tone shared by the Badge primitive and role/state presentation
// maps. Lives in types/ (a leaf) so pure helpers like util/classroomRoleUI can
// reference it without importing up into the components layer.
export type BadgeTone =
  "neutral" | "primary" | "secondary" | "info" | "success" | "warning" | "error"
