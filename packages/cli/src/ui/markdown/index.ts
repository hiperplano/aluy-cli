// EST · acabamento TUI — barrel do módulo markdown (parse + render + highlight).
export { Markdown } from './Markdown.js';
export type { MarkdownProps } from './Markdown.js';
export { CodeBlock } from './CodeBlock.js';
export type { CodeBlockProps } from './CodeBlock.js';
export { TableBlock } from './TableBlock.js';
export type { TableBlockProps } from './TableBlock.js';
export {
  parseMarkdown,
  parseInline,
  type MdBlock,
  type Inline,
  type ParagraphBlock,
  type HeadingBlock,
  type QuoteBlock,
  type ListItemBlock,
  type CodeBlockBlock,
  type TableBlockNode,
  type TableAlign,
} from './parse.js';
export { highlightToSegments, resolveLanguage, type HlSegment } from './highlight.js';
