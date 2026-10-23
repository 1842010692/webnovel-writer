import { isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/** A CLI must neither import nor bundle a second copy of a Host runtime. */
export function checkCliDependencies(result) {
  for (const output of Object.values(result.metafile.outputs)) {
    for (const entry of output.imports) {
      if (!isBuiltin(entry.path)) throw new Error(`CLI requires a non-Node module: ${entry.path}`)
    }
  }
  for (const input of Object.keys(result.metafile.inputs)) {
    if (/(?:^|\/)node_modules\/(?:@deepseek-ai\/|react\/)/.test(input.replaceAll('\\', '/'))) {
      throw new Error(`CLI bundled a shared Host runtime: ${input}`)
    }
  }
}

/** Shared by the production build and integration fixtures. */
export async function buildCli(outfile) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/cli.ts', import.meta.url))],
    outfile, bundle: true, platform: 'node', target: 'node22.19', format: 'esm',
    // Reject Host imports below instead of letting the bundler hide them in the CLI.
    external: ['@deepseek-ai/*', 'react', 'react/*', 'node:*'],
    metafile: true, sourcemap: false, legalComments: 'inline', logLevel: 'warning',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'\nconst require = __createRequire(import.meta.url)" },
  })
  checkCliDependencies(result)
  return result
}
