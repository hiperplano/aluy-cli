// RE-EXPORT — a implementação mora no core (`util/table-lines.ts`), como o `boxTable`.
//
// Os builders PORTÁVEIS (`agents-list`, `skills-list`) precisam dela sem cruzar a
// fronteira ADR-0053 §8; ter duas cópias garantiria que uma divergisse da outra — que é
// exatamente a classe de defeito que mais custou nesta base.
export { tableLines, type TableOpts } from '@hiperplano/aluy-cli-core';
export { boxTable, type BoxTableOpts } from '@hiperplano/aluy-cli-core';
