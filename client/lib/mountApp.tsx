import { StrictMode, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import '../index.css'

const queryClient = new QueryClient()

export function mountApp(page: ReactNode) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        {page}
      </QueryClientProvider>
    </StrictMode>,
  )
}
