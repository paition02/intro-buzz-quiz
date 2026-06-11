import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'

export function mountApp(page: ReactNode) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {page}
    </StrictMode>,
  )
}
