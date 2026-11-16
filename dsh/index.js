// DeepSeek Harness entry: serves the Fleet Control page below /fleet-control behind the DSH login.
// Fleet Control keeps running as its own service; this only forwards to it with a token of its own.
import { readSettings, servePanel } from './proxy.js'

export const name = 'fleet-control-panel'

export function apply(ctx, config) {
  servePanel(ctx, readSettings(process.env, config ?? {}))
}

export default { name, apply }
