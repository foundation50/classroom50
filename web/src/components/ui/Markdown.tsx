import ReactMarkdown, {
  type Components,
  type Options as ReactMarkdownOptions,
} from "react-markdown"
import { lazy, Suspense } from "react"
import { useTranslation } from "react-i18next"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"

import { normalizeGitHubMath } from "@/util/markdownMath"
import { isSafeHttpUrl } from "@/util/url"

import { cx } from "./cx"

// Renders teacher-authored assignment text in GitHub's dialect: GFM (tables,
// strikethrough, task lists, footnotes, autolinks) plus LaTeX math.
// react-markdown never uses dangerouslySetInnerHTML and (without rehype-raw,
// which we deliberately omit) drops embedded HTML, so untrusted markdown can't
// inject script. Links are further constrained to http(s) and open in a new
// tab. No @tailwindcss/typography plugin is installed, so element styling is
// spelled out per tag.
//
// KaTeX and its stylesheet are the one heavy dependency (~75 KB gzipped), so
// they live in MarkdownMath.tsx and load only when the text has a math
// delimiter. Until that chunk arrives the plain renderer shows the LaTeX
// source as a code chip, so the description is never blank.

export type MarkdownProps = {
  content: string
  className?: string
}

type RendererProps = { options: ReactMarkdownOptions; content: string }

function PlainMarkdown({ options, content }: RendererProps) {
  return <ReactMarkdown {...options}>{content}</ReactMarkdown>
}

// A tab left open across a deploy asks for a chunk hash that no longer
// exists. Falling back to the plain renderer keeps the description readable
// (math as a code chip) instead of surfacing the route's error page.
const MathMarkdown = lazy(() =>
  import("./MarkdownMath").catch(() => ({ default: PlainMarkdown })),
)

// remark-gfm's footnote reference and back-reference links point within the
// document; `user-content-` is remark-rehype's clobber prefix on those ids.
const isFootnoteAnchor = (href: string | undefined) =>
  href?.startsWith("#user-content-fn") ?? false

const components: Components = {
  // Only forward named props; react-markdown also passes a `node` (hast
  // Element) that must not spread onto the <a> as an invalid DOM attribute.
  a: ({
    href,
    children,
    id,
    "aria-label": ariaLabel,
    "aria-describedby": ariaDescribedBy,
  }) =>
    isSafeHttpUrl(href) ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="link link-primary"
      >
        {children}
      </a>
    ) : isFootnoteAnchor(href) ? (
      <a
        href={href}
        id={id}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        className="link link-primary"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  h1: ({ children }) => <h1 className="text-xl font-semibold">{children}</h1>,
  // The footnote section heading arrives as `sr-only` with an id the
  // references point at; both have to survive for screen readers.
  h2: ({ children, id, className }) => (
    <h2 id={id} className={cx("text-base font-semibold", className)}>
      {children}
    </h2>
  ),
  h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
  ul: ({ children, className }) => (
    // remark-gfm marks task lists with `contains-task-list`; those drop the
    // bullet since each item carries a checkbox instead.
    <ul
      className={cx(
        className?.includes("contains-task-list")
          ? "list-none ps-1"
          : "list-disc ps-5",
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => <ol className="list-decimal ps-5">{children}</ol>,
  input: ({ checked }) => (
    // The only <input> GFM can produce is a task-list checkbox, rendered
    // read-only: a description is documentation, not a form.
    <input
      type="checkbox"
      checked={Boolean(checked)}
      disabled
      readOnly
      className="checkbox checkbox-xs me-1.5 align-middle"
    />
  ),
  code: ({ children }) => (
    // base-300 tint reads as a code chip on both the white canvas and the
    // muted gray cards this component renders inside. text-code is Primer's
    // 13px code-block size.
    <code className="rounded bg-base-300/50 px-1 py-0.5 text-code">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-field border border-base-300 bg-base-100 p-3 text-code">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-s-2 border-base-300 ps-3 text-base-content/80">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="table table-sm w-auto">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th style={style} className="font-semibold text-base-content">
      {children}
    </th>
  ),
  td: ({ children, style }) => <td style={style}>{children}</td>,
  del: ({ children }) => <del className="opacity-70">{children}</del>,
  hr: () => <hr className="border-base-300" />,
}

export function Markdown({ content, className }: MarkdownProps) {
  const { t } = useTranslation()
  const { text, hasMath } = normalizeGitHubMath(content)
  const options: ReactMarkdownOptions = {
    components,
    remarkPlugins: [remarkGfm, remarkMath],
    // remark-gfm's footnote labels are read by screen readers (the section
    // heading is visually hidden), so they are translated like any label.
    remarkRehypeOptions: {
      footnoteLabel: t("components.markdown.footnotes"),
      footnoteBackLabel: (referenceIndex, rereferenceIndex) =>
        t("components.markdown.backToReference", {
          reference:
            rereferenceIndex > 1
              ? `${referenceIndex + 1}-${rereferenceIndex}`
              : String(referenceIndex + 1),
        }),
    },
  }
  const plain = <PlainMarkdown options={options} content={text} />
  return (
    <div
      className={cx(
        "flex flex-col gap-2 text-base-content/80 leading-relaxed break-words",
        className,
      )}
    >
      {hasMath ? (
        <Suspense fallback={plain}>
          <MathMarkdown options={options} content={text} />
        </Suspense>
      ) : (
        plain
      )}
    </div>
  )
}

export default Markdown
