import type { ComponentPropsWithoutRef } from 'react'

const BASE = 'inline-flex items-center justify-center rounded-full font-bold cursor-pointer no-underline transition disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none'

const VARIANT_CLASSES = {
  primary: `${BASE} px-5 py-3 text-cocoa bg-linear-to-br from-pink to-amber shadow-lg`,
  ghost: `${BASE} px-5 py-3 text-cream bg-white/10 border border-white/10`,
  ghostSmall: `${BASE} px-3 py-1.5 text-sm text-cream bg-white/10 border border-white/10`,
  danger: `${BASE} px-5 py-3 text-rose bg-rose/10`,
} as const

type ButtonVariant = keyof typeof VARIANT_CLASSES

export function Button({ variant = 'primary', className = '', ...props }: { variant?: ButtonVariant; className?: string } & ComponentPropsWithoutRef<'button'>) {
  return <button className={`${VARIANT_CLASSES[variant]} ${className}`} {...props} />
}
