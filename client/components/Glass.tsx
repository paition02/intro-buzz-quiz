import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react'

const GLASS_BASE = 'bg-white/5 border border-white/10 shadow-2xl backdrop-blur-lg'

type GlassProps<T extends ElementType> = {
  as?: T
  className?: string
  children?: ReactNode
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'className' | 'children'>

// すりガラス風パネル。見た目だけ共通化し、要素種別とレイアウト用クラスは呼び出し側に委ねる。
export function Glass<T extends ElementType = 'div'>({ as, className = '', children, ...props }: GlassProps<T>) {
  const Component = (as ?? 'div') as ElementType
  return (
    <Component className={`${GLASS_BASE} ${className}`} {...props}>
      {children}
    </Component>
  )
}
