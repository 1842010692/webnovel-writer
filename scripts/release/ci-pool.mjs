import fs from 'node:fs'
import path from 'node:path'
import { ForksPoolWorker } from 'vitest/node'

/** Add exit evidence to Vitest's pinned fork implementation without changing it. */
export function diagnosticForks(directory) {
  let sequence = 0
  return {
    name: 'diagnostic-forks',
    createPoolWorker(options) {
      const id = ++sequence
      return new class extends ForksPoolWorker {
        name = 'diagnostic-forks'
        async start() {
          this.plannedStop = false
          this.unexpectedDisconnect = false
          await super.start()
          // A crashed fork can close IPC before emitting exit. Vitest may call
          // stop() in response; that cleanup must not reclassify the crash.
          this.on('disconnect', () => { if (!this.plannedStop) this.unexpectedDisconnect = true })
          this.on('exit', (code, signal) => {
            fs.mkdirSync(directory, { recursive: true })
            fs.appendFileSync(path.join(directory, 'workers.jsonl'), JSON.stringify({
              worker: id, code, signal: signal ?? null, planned: this.plannedStop && !this.unexpectedDisconnect, at: Date.now(),
            }) + '\n')
          })
        }
        async stop() { this.plannedStop = true; await super.stop() }
      }(options)
    },
  }
}
