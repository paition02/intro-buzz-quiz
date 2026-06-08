import type { ReactNode } from 'react'
import { ConsolePage } from './pages/ConsolePage'
import { GameboardPage } from './pages/GameboardPage'
import { HomePage } from './pages/HomePage'
import { ActionPage } from './pages/ActionPage'

// ここが要点だ！ルートごとに表示するタイトルを 1 か所にまとめておく。
const routeTitles: Record<string, string> = {
  '/console': 'ホストコンソール | 早押しイントロクイズ',
  '/gameboard': 'ゲームボード | 早押しイントロクイズ',
  '/action': '早押しボタン | 早押しイントロクイズ',
}
const defaultTitle = '早押しイントロクイズ'

export default function App() {
  const path = window.location.pathname
  const pageTitle = routeTitles[path] ?? defaultTitle

  let page: ReactNode
  if (path === '/console') page = <ConsolePage />
  else if (path === '/gameboard') page = <GameboardPage />
  else if (path === '/action') page = <ActionPage />
  else page = <HomePage />

  return (
    <>
      <title>{pageTitle}</title>
      {page}
    </>
  )
}
