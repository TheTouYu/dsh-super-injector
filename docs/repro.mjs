const CORDIS = '/home/h/.npm-dlabal/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
const { Context } = await import(CORDIS)
const ctx = new Context()

// 插件 apply 永不 resolve（模拟：apply 内部 await 一个永不落定的 Promise）
let applyEntered = false
const stuckPlugin = async (c) => {
  applyEntered = true
  console.log('  [plugin] apply 进入，开始永不落定的 await…')
  await new Promise(() => {})   // 永不 resolve
}
const fiber = ctx.registry.plugin(stuckPlugin, {}, () => [])
await new Promise(r => setTimeout(r, 200))
console.log('  applyEntered =', applyEntered, ' fiber.state =', fiber.state, '(1=loading)')

console.log('→ 现在调用 fiber.dispose()，看它是否落定…')
const t0 = Date.now()
let settled = null
fiber.dispose().then(() => { settled = 'resolved'; }, (e) => { settled = 'rejected: ' + e })

for (const wait of [500, 1500, 3000]) {
  await new Promise(r => setTimeout(r, wait))
  console.log(`  ${Date.now()-t0}ms: settled=${settled}  state=${fiber.state}`)
  if (settled) break
}
console.log(settled ? '=== 结论：dispose 会落定 ===' : '=== 结论：dispose 永不落定（挂死）===')
process.exit(0)
