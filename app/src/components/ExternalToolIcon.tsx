import catalog from '@shared/external-tool-icons.json'
import type { IconProps } from './icons'

export function ExternalToolIcon({ icon, size = 14, stroke = 1.6, ...rest }: IconProps & { icon?: string }) {
  const definition = catalog.find(entry => entry.id === icon) || catalog[0]
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke}
    strokeLinecap="round" strokeLinejoin="round" data-external-icon={definition.id} aria-hidden="true" {...rest}>
    <path d={definition.path} />
  </svg>
}
