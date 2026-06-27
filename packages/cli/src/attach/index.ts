// EST-0957 — barrel do canal `@arquivo` (fuzzy-pick → injeta contexto).
// Lógica PURA (fuzzy/mentions/path-deny) + o leitor confinado (reader). A UI do
// picker vive em ../ui/components/FilePicker.tsx; o índice concreto em
// ../io/file-index.ts (I/O). Tudo atrás do confinamento de workspace (EST-0948) +
// path-deny (CLI-SEC-6 baseline) — o `@` não vira bypass (gate seguranca-light).
export { classifyAttachPath, isPickable, type AttachVerdict } from './path-deny.js';
export { fuzzyScore, filterFuzzy, type FuzzyHit } from './fuzzy.js';
export { parseAtMentions, stripMentions, type AtMention } from './mentions.js';
export { trailingMention, stripTrailingMention, type TrailingMention } from './compose.js';
export {
  AttachReader,
  DEFAULT_MAX_ATTACH_CHARS,
  type AttachResult,
  type AttachReaderOptions,
  type AttachOptions,
} from './reader.js';
