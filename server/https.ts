import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'

function runOpenSsl(args: string[], cwd: string) {
  const result = spawnSync('openssl', args, { cwd, encoding: 'utf8' })
  if (result.status === 0) return
  const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  throw new Error(`openssl ${args.join(' ')} failed${details ? `:\n${details}` : ''}`)
}

function lanAddresses() {
  const addresses: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === 'IPv4') addresses.push(entry.address)
    }
  }
  return addresses
}

function ensureCertificate() {
  const certDir = resolve(process.cwd(), '.certs')
  const caKey = join(certDir, 'intro-buzz-ca.key')
  const caCert = join(certDir, 'intro-buzz-ca.crt')
  const serverKey = join(certDir, 'server.key')
  const serverCsr = join(certDir, 'server.csr')
  const serverCert = join(certDir, 'server.crt')
  const serverExt = join(certDir, 'server.ext')

  mkdirSync(certDir, { recursive: true, mode: 0o700 })

  if (!existsSync(caKey) || !existsSync(caCert)) {
    runOpenSsl([
      'req', '-x509', '-new', '-nodes',
      '-newkey', 'rsa:2048', '-keyout', caKey,
      '-sha256', '-days', '3650',
      '-subj', '/CN=Intro Buzz Quiz Local CA',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-out', caCert,
    ], certDir)
    chmodSync(caKey, 0o600)
  }

  if (!existsSync(serverKey)) {
    runOpenSsl(['genrsa', '-out', serverKey, '2048'], certDir)
    chmodSync(serverKey, 0o600)
  }

  const altNames = ['DNS:localhost', 'IP:127.0.0.1', 'IP:::1', ...lanAddresses().map((address) => `IP:${address}`)]
  writeFileSync(serverExt, [
    'basicConstraints = CA:FALSE',
    'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    `subjectAltName = ${altNames.join(', ')}`,
    '',
  ].join('\n'))

  runOpenSsl(['req', '-new', '-key', serverKey, '-subj', '/CN=localhost', '-out', serverCsr], certDir)
  runOpenSsl([
    'x509', '-req', '-in', serverCsr,
    '-CA', caCert, '-CAkey', caKey, '-CAcreateserial',
    '-days', '825', '-sha256', '-extfile', serverExt,
    '-out', serverCert,
  ], certDir)

  return {
    cert: `${readFileSync(serverCert, 'utf8')}${readFileSync(caCert, 'utf8')}`,
    key: readFileSync(serverKey, 'utf8'),
  }
}

export function serve<WebSocketData, R extends string>(options: Bun.Serve.Options<WebSocketData, R> & { port: number, unix?: undefined }) {
  const server = Bun.serve(options)
  Bun.serve({ ...options, port: options.port + 1, tls: ensureCertificate() })
  return server
}
