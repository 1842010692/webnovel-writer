// Thin entry: use the plugin's shared counter, with no embedded runtime copy.
const libUrl = new URL('../../../lib/index.js', import.meta.url)
try {
  const { draftLengthCli } = await import(libUrl)
  process.exitCode = draftLengthCli(process.argv.slice(2))
} catch (err) {
  console.error(`无法加载插件运行库 lib/index.js（${libUrl.href}）：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 3
}
