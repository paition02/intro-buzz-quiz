import { resolve } from 'node:path'
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir,'entry.tsx')],
  outdir: process.argv[2], target: 'browser',
  plugins: [{name:'test-socket', setup(build) {
    build.onResolve({filter:/^socket.io-client$/},()=>({path:resolve(import.meta.dir,'socket.ts')}))
  }}],
})
if (!result.success) { console.error(result.logs); process.exit(1) }
