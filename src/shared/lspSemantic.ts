export interface SemanticLegend {
  types: string[]
  mods: string[]
}

/**
 * Cohosted languages may append token kinds to the host's legend. Only adopt
 * compatible extensions: every existing index must keep its original meaning.
 */
export function extendSemanticLegend(current: SemanticLegend | null, params: unknown): SemanticLegend | null {
  if (!current) return current
  const registrations = (params as { registrations?: unknown[] } | null)?.registrations
  if (!Array.isArray(registrations)) return current
  let legend = current
  for (const raw of registrations) {
    const reg = raw as { method?: string; registerOptions?: { legend?: { tokenTypes?: unknown; tokenModifiers?: unknown } } } | null
    if (reg?.method !== 'textDocument/semanticTokens') continue
    const types = reg.registerOptions?.legend?.tokenTypes
    const mods = reg.registerOptions?.legend?.tokenModifiers
    if (!Array.isArray(types) || !types.every((t) => typeof t === 'string')
      || !Array.isArray(mods) || !mods.every((t) => typeof t === 'string')) continue
    if (legend.types.every((t, i) => types[i] === t) && legend.mods.every((m, i) => mods[i] === m)) {
      legend = { types, mods }
    }
  }
  return legend
}
