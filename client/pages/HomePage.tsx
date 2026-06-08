import { QRCodeSVG } from 'qrcode.react'
import { Glass } from '../components/Glass'
import { Eyebrow } from '../components/Eyebrow'

const homeLinks = [
  { path: '/console', label: 'ホストコンソール', eyebrow: 'Host' },
  { path: '/gameboard', label: 'ゲームボード', eyebrow: 'Screen' },
  { path: '/action', label: '早押しボタン', eyebrow: 'Player' },
] as const

export function HomePage() {
  const links = homeLinks.map((link) => ({
    ...link,
    url: new URL(link.path, window.location.origin).toString(),
  }))

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 min-h-svh grid content-center gap-6">
      <header className="grid gap-3">
        <h1 className="m-0 text-4xl sm:text-6xl font-black tracking-tighter">早押しイントロクイズ</h1>
        <p className="m-0 text-subtle leading-loose">PCでサーバーを起動し、スマホはホスト操作、スクリーンはゲームボード、物理ボタンはAPIにアクセスします。</p>
      </header>
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4" aria-label="各ページへのリンク">
        {links.map((link) => (
          <Glass as="article" className="rounded-2xl p-5 min-w-0" key={link.path}>
            <div className="min-w-0">
              <Eyebrow>{link.eyebrow}</Eyebrow>
              <h2 className="m-0 text-2xl font-black leading-tight">
                <a className="text-cream underline underline-offset-4 decoration-white/45 outline-none transition hover:text-amber hover:decoration-amber focus-visible:text-amber focus-visible:decoration-amber" href={link.path} target="_blank" rel="noreferrer">{link.label}</a>
              </h2>
            </div>
            <div className="mt-5 grid place-items-center rounded-2xl border border-white/10 bg-black/40 p-4 shadow-inner shadow-black/30">
              <QRCodeSVG
                className="block h-auto drop-shadow-[0_0_18px_rgba(247,242,234,0.14)]"
                value={link.url}
                size={176}
                level="M"
                bgColor="transparent"
                fgColor="#f7f2ea"
                marginSize={4}
                title={`${link.label} ${link.url}`}
              />
            </div>
            <p className="mt-4 mb-0 min-h-10 select-text break-all text-xs leading-relaxed text-muted">{link.url}</p>
          </Glass>
        ))}
      </section>
    </main>
  )
}
