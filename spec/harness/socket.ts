// Only the transport is replaced. The production gameClient and ConsolePage
// consume these events and acknowledgements unchanged.
type Callback = (...args: unknown[]) => void
const handlers = new Map<string, Set<Callback>>()
export const pending: Array<{event: string; body: unknown; callback: Callback; done: boolean}> = []
export const socket = {
  connected: true,
  on(event: string, callback: Callback) {
    if (!handlers.has(event)) handlers.set(event, new Set())
    handlers.get(event)!.add(callback)
    return this
  },
  timeout() { return this },
  emit(event: string, ...args: unknown[]) {
    const callback = args.pop() as Callback
    pending.push({ event, body: args[0], callback, done: false })
    return this
  },
  connect() { this.connected = true; deliver('connect'); return this },
}
export function deliver(event: string, payload?: unknown) {
  handlers.get(event)?.forEach(callback => callback(structuredClone(payload)))
}
export function ack(index: number, ok = true) {
  const command = pending[index]
  if (!command || command.done) throw new Error(`No pending command ${index}`)
  command.done = true
  command.callback(null, { ok, error: ok ? undefined : 'Injected server rejection' })
}
export function io() { return socket }
export function failAck(index: number) {
  const command = pending[index]
  if (!command || command.done) throw new Error(`No pending command ${index}`)
  command.done = true
  command.callback(new Error('Injected acknowledgement timeout'))
}
export function subscriptions() { return Object.fromEntries([...handlers].map(([k,v]) => [k,v.size])) }
