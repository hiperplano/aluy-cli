// EST-0948 — barrel do tema de terminal (spec §3 / handoff §10 `theme/`).
export * from './palette.js';
export * from './glyphs.js';
export * from './theme.js';
// EST-0972 — paleta de identificação de SESSÃO (cor do /rename, ●+nome no composer).
export * from './session-colors.js';
// EST-0966 — temas NOMEADOS (/theme) + auto-detecção do fundo (OSC 11).
export * from './themes.js';
export * from './osc11.js';
export { ThemeProvider, useTheme, Role, Glyph } from './context.js';
