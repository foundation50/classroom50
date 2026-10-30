import ReactMarkdown, { type Options } from "react-markdown"
import rehypeKatex, { type Options as KatexOptions } from "rehype-katex"

import "katex/dist/katex.min.css"

// The math-enabled renderer behind Markdown.tsx's lazy import; see that file
// for why KaTeX is split out.
//
// KaTeX's defaults already keep teacher text inert: `trust` is off, so \href,
// \url, \includegraphics and raw HTML macros render as errors instead of
// elements, and rehype-katex itself catches parse errors and re-renders the
// source as a `.katex-error` chip. The two caps stop a pathological
// expression from freezing the tab or growing a glyph to the size of the page.
const katexOptions: KatexOptions = {
  strict: "ignore",
  maxSize: 500,
  maxExpand: 1000,
}

// Math is always left-to-right, even inside an RTL description; KaTeX's own
// stylesheet doesn't set direction. A wide display equation scrolls inside
// its own box instead of widening the page (1.4.10 Reflow).
const mathLayoutClass =
  "contents [&_.katex]:[direction:ltr] [&_.katex-display]:my-1 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1"

export default function MarkdownMath({
  options,
  content,
}: {
  options: Options
  content: string
}) {
  return (
    <div className={mathLayoutClass}>
      <ReactMarkdown {...options} rehypePlugins={[[rehypeKatex, katexOptions]]}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
