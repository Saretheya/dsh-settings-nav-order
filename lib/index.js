/**
 * dsh-settings-nav-order — Host 半部。
 *
 * 职责只有一件：为「设置大项拖拽排序」提供一个极小的持久化端点，
 * 把顺序记录写在**本插件自己的目录**里（`<插件根>/data/order.json`）。
 *
 * 设计约束（用户明确要求）：
 * 1. **不写 settings.yaml** —— 不注册任何 settings 命名空间，不碰官方共享配置文件。
 * 2. **不修改任何外部数据** —— 唯一写入目标是本插件目录内的 data/order.json。
 * 3. **卸载即干净** —— 文件在插件目录内，卸载插件时随目录一起消失；
 *    client 半部卸载时会把 DOM 顺序还原为官方原序。
 *
 * 数据形态（很小，就是一份顺序记录）：
 *   { "version": 1, "order": ["general", "models", "plugins", ...] }
 *
 * 写入采用 tmp + rename 原子写，避免半截文件。
 *
 * @module dsh-settings-nav-order
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-settings-nav-order'

/** HTTP 路由前缀。client 半部按同样路径读写。 */
const ROUTE_PATH = '/api/settings-nav-order'

/** 插件包根目录（本文件位于 <root>/lib/index.js）。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 顺序记录文件：插件自己的目录内，不涉及任何外部路径。 */
const DATA_DIR = join(PACKAGE_ROOT, 'data')
const DATA_FILE = join(DATA_DIR, 'order.json')

/** 顺序列表的容量上限（防御异常输入；设置大项不会超过这个数量级）。 */
const MAX_ENTRIES = 200
/** 单个 id 的长度上限。 */
const MAX_ID_LEN = 128
/** 请求体大小上限（顺序记录极小，64 KB 足够）。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 本机信任围墙：只接受来自回环地址、且非跨站的请求。
 *
 * 与 harness 保护自身 `/api/*` 的判据同源：Host 必须是本机回环，
 * 带 `Sec-Fetch-Site: cross-site` 一律拒绝，带 Origin 时必须与 Host 同源。
 * 顺序记录本身不敏感，但没有理由让任意网页改写它。
 *
 * @param headers - Node 请求头（小写键）。
 * @returns 拒绝时的 HTTP 状态码；放行时 undefined。
 */
export function localOnlyRejection(headers) {
  const host = headers.host
  if (typeof host !== 'string' || host.length === 0) return 403
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return 403
  }
  const h = hostUrl.hostname
  const loopback = h === 'localhost'
    || h === '::1'
    || h === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  if (!loopback) return 403
  if (headers['sec-fetch-site'] === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (new URL(origin).host !== hostUrl.host) return 403
    } catch {
      return 403
    }
  }
  return undefined
}

/**
 * 校验并归一化一份顺序记录。
 *
 * 宽容策略：非法项直接丢弃，不抛错——顺序记录是"锦上添花"的数据，
 * 不值得为一条脏数据让整个端点失败。无法解析时回退为空顺序（= 官方原序）。
 *
 * @param raw - 解析后的 JSON 值。
 * @returns 归一化后的顺序数组。
 */
export function normalizeOrder(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.order) ? raw.order : [])
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id.length === 0 || id.length > MAX_ID_LEN) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_ENTRIES) break
  }
  return out
}

/** 读取顺序记录；文件不存在或损坏时返回空数组（= 官方原序）。 */
async function readOrder() {
  try {
    const text = await readFile(DATA_FILE, 'utf8')
    return normalizeOrder(JSON.parse(text))
  } catch {
    // ENOENT（首次运行）与损坏一律按"尚无自定义顺序"处理。
    return []
  }
}

/** 原子写入顺序记录（tmp + rename）。 */
async function writeOrder(order) {
  await mkdir(DATA_DIR, { recursive: true })
  const payload = `${JSON.stringify({ version: 1, order }, null, 2)}\n`
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, DATA_FILE)
}

/** 读取请求体（带上限保护）。 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk?.length ?? 0
      if (size <= MAX_BODY_BYTES && chunk !== undefined) chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/**
 * 注册持久化端点。
 *
 * webServer 是可选服务：缺席时插件仍加载成功，只是顺序无法跨重启保存
 * （client 半部会退化为"仅本次会话内有效"，并在控制台给出提示）。
 */
export function apply(ctx) {
  const installRoutes = (sctx) => {
    const webServer = sctx.get('webServer')
    if (webServer === undefined) {
      ctx.logger.warn('[settings-nav-order] webServer 不可用，顺序将无法持久化')
      return
    }

    const sendJson = (res, statusCode, body) => {
      res.statusCode = statusCode
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(body))
    }

    const route = {
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: async (rawReq, rawRes) => {
        const req = rawReq
        const headers = req.headers ?? {}
        const rejection = localOnlyRejection(headers)
        if (rejection !== undefined) {
          sendJson(rawRes, rejection, { ok: false, error: '已拒绝跨站或非本机请求' })
          return
        }
        const action = (req.url ?? '/').split('?')[0].slice(ROUTE_PATH.length).replace(/\/+$/, '') || '/'

        try {
          if (req.method === 'GET' && (action === '/' || action === '/order')) {
            sendJson(rawRes, 200, { ok: true, order: await readOrder() })
            return
          }
          if (req.method === 'POST' && action === '/order') {
            if (!/application\/json/i.test(String(headers['content-type'] ?? ''))) {
              sendJson(rawRes, 415, { ok: false, error: 'Content-Type 必须是 application/json' })
              return
            }
            const text = await readBody(req)
            let parsed
            try {
              parsed = JSON.parse(text)
            } catch {
              sendJson(rawRes, 400, { ok: false, error: 'body 不是合法 JSON' })
              return
            }
            const order = normalizeOrder(parsed)
            await writeOrder(order)
            ctx.logger.info('[settings-nav-order] 已保存 %d 个大项顺序', order.length)
            sendJson(rawRes, 200, { ok: true, order })
            return
          }
          if (req.method === 'POST' && action === '/reset') {
            await writeOrder([])
            ctx.logger.info('[settings-nav-order] 顺序记录已重置（回到官方原序）')
            sendJson(rawRes, 200, { ok: true, order: [] })
            return
          }
          sendJson(rawRes, 404, { ok: false, error: `unknown action: ${action}` })
        } catch (error) {
          ctx.logger.error('[settings-nav-order] 请求处理失败')
          ctx.logger.error(error)
          sendJson(rawRes, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }

    // effect 必须挂在 inject 回调的作用域 ctx 上，随 fiber 卸载自动撤销路由。
    sctx.effect(() => webServer.register(route))
  }

  ctx.inject(['webServer'], (sctx) => { installRoutes(sctx) })
}
