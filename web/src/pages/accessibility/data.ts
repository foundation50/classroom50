import { useQuery } from "@tanstack/react-query"

import type { BadgeTone } from "@/types/badgeTone"
import { cx } from "@/components/ui"
import { type ConformanceLevel } from "@/util/a11y/vpatModel"
import type {
  ContrastAuditJson,
  ContrastStatus,
} from "@/util/a11y/contrastReport"
import type { VpatReportJson } from "@/util/a11y/vpatReport"

// Shared types, fetch hooks, and one-source recipes for the /accessibility
// sections. The audit/report shapes reuse the canonical producer types
// (ContrastAuditJson from contrastReport, VpatReportJson from vpatReport) so a
// producer-side schema change is a compile error at the consumer instead of a
// silent drift.

export type ContrastAuditRow =
  ContrastAuditJson["themes"][number]["rows"][number]
export type ContrastAuditTheme = ContrastAuditJson["themes"][number]

// Terse aliases for the JSX call sites.
export type Row = ContrastAuditRow
export type AuditTheme = ContrastAuditTheme
export type Audit = ContrastAuditJson

export type { ContrastStatus }

export const STATUS_TONE: Record<ContrastStatus, BadgeTone> = {
  pass: "success",
  fail: "error",
  exempt: "neutral",
}

export type Vpat = Pick<
  VpatReportJson,
  | "schema"
  | "product"
  | "generated"
  | "summary"
  | "criteria"
  | "standard"
  | "target"
>

// One shared fetch of the build-emitted vpat-report.json, so the conformance
// table and the statement's "last reviewed" date read from a single request
// (the sections are hash-routed, so a plain useEffect fetch would re-download
// on every switch between them). Static asset, so cache indefinitely.
export function useVpatReport() {
  return useQuery({
    queryKey: ["vpat-report"],
    queryFn: async (): Promise<Vpat> => {
      const res = await fetch("/vpat-report.json")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<Vpat>
    },
    staleTime: Infinity,
  })
}

// One shared fetch of the build-emitted contrast-audit.json (static asset), so
// the contrast table and the printable full report read from a single request.
export function useContrastAudit() {
  return useQuery({
    queryKey: ["contrast-audit"],
    queryFn: async (): Promise<Audit> => {
      const res = await fetch("/contrast-audit.json")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<Audit>
    },
    staleTime: Infinity,
  })
}

// Tone -> the small status-dot swatch class. One source, shared by the VPAT stat
// chips (Badge owns the badge recipe; this is only the bare dot).
export const TONE_DOT_CLASS: Record<BadgeTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  neutral: "bg-base-content/40",
  info: "bg-info",
  primary: "bg-primary",
  secondary: "bg-secondary",
}

// The order the VPAT summary chips + status filter render in: best-first, then
// the out-of-band statuses (not applicable, not evaluated) last.
export const VPAT_STATUS_ORDER: ConformanceLevel[] = [
  "supports",
  "partially",
  "doesNotSupport",
  "notApplicable",
  "notEvaluated",
]

// Shared boxed-tab recipe so the active tab reads unambiguously (solid primary
// fill) and inactive tabs stay clickable-looking. One source for both the
// principle tabs and the theme tabs.
export function tabClass(active: boolean): string {
  return cx(
    "tab cursor-pointer gap-1.5",
    active
      ? "tab-active rounded-box !bg-primary font-semibold !text-primary-content"
      : "text-base-content/60 hover:text-base-content",
  )
}
