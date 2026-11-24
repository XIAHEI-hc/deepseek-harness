/**
 * Minimal HTTP runtime used to verify the container supervisor without building
 * the full DSH runtime image. The supervisor passes the same argument vector a
 * real runtime receives; this entrypoint only serves readiness on the requested
 * container address so lifecycle, mounts, and isolation can be exercised.
 */
import { createServer } from 'node:http'

/** Read one `--flag value` argument from the supervisor-provided argv. */
function flag(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const host = flag('--host')
const port = Number(flag('--port'))
if (host === undefined || !Number.isInteger(port) || port <= 0) {
  console.error('probe runtime: --host and --port are required')
  process.exit(2)
}
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('dsh-runtime-probe\n')
})
server.listen(port, host, () => {
  console.log(`probe runtime listening on ${host}:${port}`)
})
process.on('SIGTERM', () => {
  server.close(() => { process.exit(0) })
})
process.on('SIGINT', () => {
  server.close(() => { process.exit(0) })
})
