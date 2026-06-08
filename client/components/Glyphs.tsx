import type { CSSProperties } from 'react'

// CSS の ::before/::after で描いていた形は inline SVG コンポーネントにした。
// inline なら fill / stroke / currentColor がそのまま効く(外部ファイル参照だとホスト CSS が
// 中に届かないので不可)。塗り = プレイヤー色、白縁 = stroke、グロー = style の filter で出す。
// viewBox は stroke がはみ出ても切れないよう周囲に 2 単位の余白を持たせている。
export function PersonGlyph({ color, className, style, label }: { color: string; className?: string; style?: CSSProperties; label?: string }) {
  return (
    <svg
      viewBox="-2 -2 40 56"
      className={className}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g fill={color} stroke="rgba(255,255,255,0.5)" strokeWidth={2.5} strokeLinejoin="round">
        {/* 胴体を先、顔を後に描いて顔(head)を前面に出す */}
        <path d="M0,40 A18,18 0 0 1 36,40 L36,42 A10,10 0 0 1 26,52 L10,52 A10,10 0 0 1 0,42 Z" />
        <circle cx="18" cy="12" r="12" />
      </g>
    </svg>
  )
}

export function ChevronGlyph({ color, className }: { color?: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke={color ?? 'currentColor'} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9 L12 15 L18 9" />
    </svg>
  )
}

export function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5 L9.3 16.5 L19 7.5" />
    </svg>
  )
}
