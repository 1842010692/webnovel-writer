/**
 * 材料备料：从同包独立 CLI 运行库调用现有只读计算。
 * 退出码：沿用业务返回值；2 执行异常；3 运行库无法加载或导出不符。
 */
const libUrl = new URL('../../../lib/cli.js', import.meta.url)
let run
try {
  const lib = await import(libUrl)
  run = lib.materialsCli
  if (typeof run !== 'function') throw new Error('运行库缺少 materialsCli，请核对插件文件版本')
} catch (err) {
  console.error(`无法加载技能运行库 lib/cli.js（${libUrl.href}）：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 3
}
if (typeof run === 'function') {
  try {
    process.exitCode = await run(process.argv.slice(2))
  } catch (err) {
    console.error(`材料备料执行异常：${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 2
  }
}
