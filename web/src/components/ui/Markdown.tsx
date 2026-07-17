import ReactMarkdown, { type Components } from "react-markdown"

import { isSafeHttpUrl } from "@/util/url"

import { cx } from "./cx"

// Renders teacher-authored assignment text. react-markdown never uses
// dangerouslySetInnerHTML and (without rehype-raw, which we deliberately omit)
// drops embedded HTML, so untrusted markdown can't inject script. Links are
// further constrained to http(s) and open in a new tab. No @tailwindcss/typography
// plugin is installed, so element styling is spelled out per tag.

export type MarkdownProps = {
  content: string
  className?: string
}

const components: Components = {
  // Only forward href/children; react-markdown also passes a `node` (hast
  // Element) that must not spread onto the <a> as an invalid DOM attribute.
  a: ({ href, children }) =>
    isSafeHttpUrl(href) ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="link link-primary"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  h1: ({ children }) => <h1 className="text-xl font-bold">{children}</h1>,
  h2: ({ children }) => <h2 className="text-lg font-bold">{children}</h2>,
  h3: ({ children }) => <h3 className="text-base font-semibold">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc ps-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal ps-5">{children}</ol>,
  code: ({ children }) => (
    <code className="rounded bg-base-200 px-1 py-0.5 text-sm">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg bg-base-200 p-3 text-sm">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-s-2 border-base-300 ps-3 text-base-content/80">
      {children}
    </blockquote>
  ),
}

export function Markdown({ content, className }: MarkdownProps) {
  return (
    <div
      className={cx(
        "flex flex-col gap-2 text-base-content/80 leading-relaxed break-words",
        className,
      )}
    >
      <ReactMarkdown components={components}>{content}</ReactMarkdown>
    </div>
  )
}

export default Markdown
