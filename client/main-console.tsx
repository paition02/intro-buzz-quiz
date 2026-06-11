import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { mountApp } from './lib/mountApp'
import { ConsolePage } from './pages/ConsolePage'

const queryClient = new QueryClient()

mountApp(
  <QueryClientProvider client={queryClient}>
    <ConsolePage />
  </QueryClientProvider>,
)
