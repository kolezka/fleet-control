// DeepSeek Harness entry: serves the Fleet Control page below /fleet-control behind the DSH login.
// Fleet Control keeps running as its own service; this only forwards to it with a token of its own.
import { servePanel } from './proxy.js'

export const name = 'fleet-control-panel'

export function apply(ctx) {
  servePanel(ctx)
}

export default { name, apply }
