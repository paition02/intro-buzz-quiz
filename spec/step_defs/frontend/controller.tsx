import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useLayoutEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConsolePage } from '../../../client/pages/ConsolePage'
import { GameboardPage } from '../../../client/pages/GameboardPage'
import { usePlaybackTarget, type PlaybackTarget } from '../../../client/usePlaybackTarget'
import { musicKitInstanceStore } from '../../../client/musicKitStore'
import { initialState } from '../../../client/lib/gameClient'
import { deliver, ack, failAck, pending, subscriptions } from './controlled_socket'

const queryClient = new QueryClient({defaultOptions:{queries:{retry:false}}})
let root = createRoot(document.getElementById('root')!)
let controller: ReturnType<typeof usePlaybackTarget>
const outcomes: Record<string, string> = {}
function Controller() {
  const value = usePlaybackTarget()
  useLayoutEffect(() => { controller = value }, [value])
  return <div>Controller</div>
}
const harness = {
  deliver, ack, failAck, initialState, subscriptions,
  commands: () => pending.map(({event,body,done})=>({event,body,done})),
  ready: () => musicKitInstanceStore.getSnapshot().instance !== null,
  render(kind: string) {
    flushSync(() => root.render(<QueryClientProvider client={queryClient}>{kind === 'console' ? <ConsolePage/> : kind === 'board' ? <GameboardPage/> : <Controller/>}</QueryClientProvider>))
  },
  unmount() { flushSync(()=>root.unmount()); root=createRoot(document.getElementById('root')!) },
  target(target: PlaybackTarget, name: string) {
    outcomes[name] = 'pending'
    controller.setTarget(target).then(()=>{outcomes[name]='resolved'}, e=>{outcomes[name]=e.name+': '+e.message})
  },
  inspect: () => ({ outcomes, status: controller?.status, subscriptions: subscriptions() }),
}
Object.assign(window, { harness })
