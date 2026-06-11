import type { ReactNode } from 'react'

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-amber uppercase tracking-widest text-xs font-black mb-2">{children}</p>
}
