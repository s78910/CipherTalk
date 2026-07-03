/**
 * SDK 运行时 smoke：mock 最小 DOM + 成对 MessagePort，验证
 * 握手 → RPC 往返 → 事件分发 → capabilities。
 * 运行：node plugin-sdk/test/test-sdk.mjs
 */
import assert from 'assert'

// —— 最小 DOM mock ——
const listeners = { message: [] }
globalThis.window = {
  addEventListener: (type, handler) => { (listeners[type] ||= []).push(handler) },
  removeEventListener: (type, handler) => {
    if (listeners[type]) listeners[type] = listeners[type].filter((h) => h !== handler)
  },
}
const noop = () => {}
globalThis.document = {
  documentElement: { style: { setProperty: noop }, classList: { toggle: noop } },
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute: noop }),
  head: { prepend: noop },
  addEventListener: noop,
}

// —— 成对 MessagePort mock（异步投递，语义贴近真实） ——
class FakePort {
  constructor() { this.onmessage = null; this._peer = null }
  postMessage(data) {
    const peer = this._peer
    queueMicrotask(() => { if (peer && peer.onmessage) peer.onmessage({ data }) })
  }
  close() {}
}
function portPair() {
  const a = new FakePort(); const b = new FakePort()
  a._peer = b; b._peer = a
  return [a, b]
}

const tick = () => new Promise((r) => setTimeout(r, 0))

const { connect, API_VERSION, SDK_VERSION } = await import('../ciphertalk-plugin-sdk.js')
assert.strictEqual(API_VERSION, 1, 'API_VERSION 应导出为 1')
assert.ok(typeof SDK_VERSION === 'string', 'SDK_VERSION 应为字符串')

const apiPromise = connect()

// 模拟宿主：连上 plugin 端口，充当被调用方
const [hostPort, pluginPort] = portPair()
hostPort.onmessage = (e) => {
  const m = e.data
  if (m.type === 'invoke') {
    // 回显方法名，便于断言路由正确
    hostPort.postMessage({ type: 'result', id: m.id, ok: true, data: { method: m.method, args: m.args } })
  }
}

// 投递宿主握手消息给 SDK 注册的 window message 监听器
assert.ok(listeners.message.length > 0, 'connect 应注册 message 监听')
listeners.message[0]({
  data: { type: 'ciphertalk:connect', pluginId: 'com.test.p', viewId: 'index', context: { sessionId: 's1' }, theme: { vars: {} }, uiKit: '' },
  ports: [pluginPort],
})

const api = await apiPromise
assert.strictEqual(api.pluginId, 'com.test.p', 'pluginId 应来自握手')
assert.strictEqual(api.context.sessionId, 's1', 'context 应透传')
assert.strictEqual(api.apiVersion, 1, 'api.apiVersion')

// RPC 往返：方法名与参数正确路由
const r1 = await api.data.messages.query({ sessionId: 's1', limit: 10 })
assert.strictEqual(r1.method, 'data.messages.query', '方法名应正确路由')
assert.strictEqual(r1.args.sessionId, 's1', '参数应透传')

const r2 = await api.ai.embed(['a', 'b'])
assert.strictEqual(r2.method, 'ai.embed', 'ai.embed 路由')
assert.deepStrictEqual(r2.args.texts, ['a', 'b'], 'embed 参数包装为 { texts }')

const caps = await api.capabilities()
assert.strictEqual(caps.method, 'host.capabilities', 'capabilities 走 host.capabilities')

// 事件分发：宿主推事件 → 插件订阅回调收到
let received = null
const off = api.events.on('newMessages', (p) => { received = p })
hostPort.postMessage({ type: 'event', event: 'newMessages', payload: { sessionId: 's1', count: 3 } })
await tick()
assert.deepStrictEqual(received, { sessionId: 's1', count: 3 }, '事件应分发到订阅者')
off()
received = null
hostPort.postMessage({ type: 'event', event: 'newMessages', payload: { sessionId: 's2' } })
await tick()
assert.strictEqual(received, null, '退订后不应再收到')

console.log('✅ SDK 运行时 smoke 全部通过')
