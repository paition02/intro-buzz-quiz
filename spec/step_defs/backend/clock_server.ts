// Isolated process: freeze only the clock used by the real server's cooldown.
// Never import this entrypoint in production.
let now = 2_000_000_000_000
Date.now = () => now
const control = Bun.serve({hostname:'127.0.0.1',port:Number(process.env.TEST_CLOCK_PORT),fetch(req){
  const value = new URL(req.url).searchParams.get('now')
  if(value!==null){ const next=Number(value);if(!Number.isFinite(next))return new Response('',{status:400});now=next }
  return Response.json({now})
}})
await import('../../../server/index.ts')
console.log(`TEST_CLOCK_READY ${control.port}`)
