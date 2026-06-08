// 共通の className 束。Tailwind ユーティリティを React 側でまとめて DRY に保つ。
export const GLASS = 'bg-white/5 border border-white/10 shadow-2xl backdrop-blur-lg'
export const BTN = 'inline-flex items-center justify-center rounded-full font-bold cursor-pointer no-underline transition disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none'
export const BTN_PRIMARY = `${BTN} px-5 py-3 text-cocoa bg-linear-to-br from-pink to-amber shadow-lg`
export const BTN_GHOST = `${BTN} px-5 py-3 text-cream bg-white/10 border border-white/10`
export const BTN_GHOST_SMALL = `${BTN} px-3 py-1.5 text-sm text-cream bg-white/10 border border-white/10`
export const BTN_DANGER = `${BTN} px-5 py-3 text-rose bg-rose/10`
export const INPUT_BASE = 'w-full rounded-2xl border border-white/10 bg-black/20 text-white px-4 py-3 disabled:opacity-60'
export const HINT = 'text-muted'
export const EYEBROW = 'text-amber uppercase tracking-widest text-xs font-black mb-2'
export const JUDGE_RESULT_DURATION_MS = 1800
