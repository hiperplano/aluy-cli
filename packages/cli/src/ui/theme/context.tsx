// EST-0948 — contexto React do tema de terminal + helpers de consumo.
//
// O componente raiz resolve o tema UMA vez (resolveTheme) e o injeta aqui. Os
// componentes leem via `useTheme()` — NUNCA cor crua, só papéis (regra mestra
// §3.1 / ADR-0041). `<Glyph>` cola o glifo resolvido; `<Role>` aplica o estilo
// de um papel a um `<Text>`.

import React, { createContext, useContext } from 'react';
import { Text } from 'ink';
import { resolveTheme, type Theme } from './theme.js';
import type { TermRole } from './palette.js';
import type { GlyphName } from './glyphs.js';

const ThemeContext = createContext<Theme>(resolveTheme());

export function ThemeProvider(props: {
  readonly theme: Theme;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return <ThemeContext.Provider value={props.theme}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/** Texto pintado por um PAPEL semântico (nunca cor crua). */
export function Role(props: {
  readonly name: TermRole;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const theme = useTheme();
  const style = theme.role(props.name);
  // exactOptionalPropertyTypes: só passamos as props DEFINIDAS (não `undefined`).
  const textProps: {
    color?: string;
    bold?: boolean;
    dimColor?: boolean;
    inverse?: boolean;
  } = {};
  if (style.color !== undefined) textProps.color = style.color;
  if (style.bold !== undefined) textProps.bold = style.bold;
  if (style.dimColor !== undefined) textProps.dimColor = style.dimColor;
  if (style.inverse !== undefined) textProps.inverse = style.inverse;
  return <Text {...textProps}>{props.children}</Text>;
}

/** Glifo resolvido (Unicode/ASCII), opcionalmente pintado por um papel. */
export function Glyph(props: {
  readonly name: GlyphName;
  readonly role?: TermRole;
}): React.ReactElement {
  const theme = useTheme();
  const g = theme.glyph(props.name);
  if (props.role) {
    return <Role name={props.role}>{g}</Role>;
  }
  return <Text>{g}</Text>;
}
