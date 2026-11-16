import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'

/** Where the Fleet Control page is served inside the DSH web app. */
export const PANEL_PREFIX = '/fleet-control'
/** The one WebSocket path: DSH routes upgrades by exact path, so the session rides in the query. */
export const TERMINAL_PATH = PANEL_PREFIX + '/api/terminal'

// Only what the page needs goes upstream. DSH cookies and auth headers stay in DSH.
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'content-length', 'if-none-match']
const PASSED_HEADERS = ['content-type', 'cache-control', 'etag', 'content-security-policy', 'x-content-type-options']
// Bun bundles the page with absolute asset paths; below the prefix they must point back here.
const REWRITTEN = /^(text\/html|text\/css|text\/javascript|application\/javascript)/
const MAX_REWRITE_BYTES = 8 * 1024 * 1024

/**
 * Reads the panel settings. The token file holds one Fleet Control token for a principal of
 * its own; it is read at start and never sent to the browser.
 */
export function readSettings(env = process.env, config = {}) {
  // The plugin row in cordis.patch.yml wins, so no change to how DSH is started is needed.
  const upstream = config.url ?? env.FLEET_CONTROL_PANEL_URL
  const tokenFile = config.tokenFile ?? env.FLEET_CONTROL_PANEL_TOKEN_FILE
  const caFile = config.caFile ?? env.FLEET_CONTROL_PANEL_CA
  if (!upstream || !tokenFile) return { error: 'Set url and tokenFile in the plugin config, or FLEET_CONTROL_PANEL_URL and FLEET_CONTROL_PANEL_TOKEN_FILE for the DSH process.' }
  let url
  try {
    url = new URL(upstream)
  } catch {
    return { error: 'FLEET_CONTROL_PANEL_URL is not a URL.' }
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    return { error: 'FLEET_CONTROL_PANEL_URL must be https (http only on loopback).' }
  }
  let token
  let ca
  try {
    token = readFileSync(tokenFile, 'utf8').trim()
    ca = caFile ? readFileSync(caFile, 'utf8') : undefined
  } catch {
    return { error: 'The token or CA file could not be read.' }
  }
  if (!/^\S{16,512}$/.test(token)) return { error: 'The token file does not hold one token.' }
  return { upstream: new URL(url.origin), token, ca }
}

/** Registers the page route and the terminal socket route on the DSH web server. */
export function servePanel(ctx, settings = readSettings()) {
  ctx.inject(['webServer', 'connection'], (sub) => {
    sub.effect(
      () =>
        sub.webServer.register({
          kind: 'prefix',
          path: PANEL_PREFIX,
          // A failure must end this one response, not reach DSH as an unhandled rejection.
          handler: (req, res) => {
            try {
              respond(sub.connection, settings, req, res)
            } catch {
              res.headersSent ? res.destroy() : end(res, 500)
            }
          },
        }),
      'fleet-control: page route',
    )
    sub.effect(
      () => sub.webServer.registerUpgrade({ path: TERMINAL_PATH, handler: (req, socket, head) => relaySocket(sub.connection, settings, req, socket, head) }),
      'fleet-control: terminal route',
    )
  })
}

export function respond(connection, settings, req, res) {
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) return end(res, rejection)
  if (settings.error) return end(res, 503, settings.error)

  const url = new URL(String(req.url), 'http://localhost')
  // Relative paths in the page resolve below the prefix only with the trailing slash.
  if (url.pathname === PANEL_PREFIX) return end(res, 308, '', { location: PANEL_PREFIX + '/' + url.search })
  const path = url.pathname.slice(PANEL_PREFIX.length)
  // The panel signs in with its own token; the page's sign-in and sign-out are not offered here.
  if (path === '/login' || path === '/logout' || path === '/api/login') return end(res, 404, 'not found')

  const headers = { host: settings.upstream.host, authorization: 'Bearer ' + settings.token }
  for (const name of FORWARDED_REQUEST_HEADERS) if (req.headers[name] !== undefined) headers[name] = req.headers[name]
  // DSH already checked this request's origin; Fleet Control checks writes against its own.
  if (req.headers.origin !== undefined) headers.origin = settings.upstream.origin

  const upstream = send(settings, { method: req.method, path: path + url.search, headers }, (reply) => {
    const out = {}
    for (const name of PASSED_HEADERS) if (reply.headers[name] !== undefined) out[name] = reply.headers[name]
    const type = String(reply.headers['content-type'] ?? '')
    if (!REWRITTEN.test(type)) {
      res.writeHead(reply.statusCode ?? 502, out)
      reply.pipe(res)
      return
    }
    const chunks = []
    let size = 0
    reply.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_REWRITE_BYTES) return reply.destroy(new Error('too large'))
      chunks.push(chunk)
    })
    reply.on('end', () => {
      const body = Buffer.from(rewrite(Buffer.concat(chunks).toString('utf8')))
      delete out.etag
      res.writeHead(reply.statusCode ?? 502, { ...out, 'content-length': body.length })
      res.end(body)
    })
    reply.on('error', () => (res.headersSent ? res.destroy() : end(res, 502, 'Fleet Control answer failed.')))
  })
  upstream.on('error', () => (res.headersSent ? res.destroy() : end(res, 502, 'Fleet Control is not answering.')))
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

// Development builds live under /_bun/, production builds at /chunk-*. Nothing else in the page is absolute.
const BUNDLE_PATHS = ['/_bun/', '/chunk-']

/** Points Bun's absolute bundle paths below the prefix. */
export function rewrite(text) {
  for (const path of BUNDLE_PATHS) for (const quote of ['"', "'"]) text = text.replaceAll(quote + path, quote + PANEL_PREFIX + path)
  return text
}

/** Read-only terminal: Fleet Control closes the socket on any client message, so bytes pass as is. */
export function relaySocket(connection, settings, req, socket, head) {
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined || settings.error) return refuse(socket, rejection ?? 503)
  const url = new URL(String(req.url), 'http://localhost')
  const headers = {
    host: settings.upstream.host,
    authorization: 'Bearer ' + settings.token,
    origin: settings.upstream.origin,
    connection: 'Upgrade',
    upgrade: 'websocket',
  }
  for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions']) if (req.headers[name] !== undefined) headers[name] = req.headers[name]
  const upstream = send(settings, { method: 'GET', path: '/api/terminal' + url.search, headers })
  upstream.on('upgrade', (reply, remote, remoteHead) => {
    // The 30 s request timeout must not end a long-lived terminal.
    remote.setTimeout(0)
    const lines = ['HTTP/1.1 101 Switching Protocols']
    for (const [name, value] of Object.entries(reply.headers)) lines.push(name + ': ' + value)
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    if (remoteHead.length) socket.write(remoteHead)
    if (head.length) remote.write(head)
    remote.pipe(socket)
    socket.pipe(remote)
    const close = () => {
      remote.destroy()
      socket.destroy()
    }
    remote.on('error', close).on('close', close)
    socket.on('error', close).on('close', close)
  })
  upstream.on('response', (reply) => {
    reply.resume()
    refuse(socket, reply.statusCode ?? 502)
  })
  upstream.on('error', () => refuse(socket, 502))
  upstream.end()
}

function send(settings, options, onReply) {
  const base = { hostname: settings.upstream.hostname, port: settings.upstream.port || undefined, timeout: 30_000, ...options }
  const req = settings.upstream.protocol === 'https:' ? httpsRequest({ ...base, ca: settings.ca }, onReply) : httpRequest(base, onReply)
  req.on('timeout', () => req.destroy(new Error('timeout')))
  return req
}

function refuse(socket, status) {
  socket.end('HTTP/1.1 ' + status + ' Refused\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
}

function end(res, status, body = '', headers = { 'content-type': 'text/plain; charset=utf-8' }) {
  res.writeHead(status, headers)
  res.end(body)
}
