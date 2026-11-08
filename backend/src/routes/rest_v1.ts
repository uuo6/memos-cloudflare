// REST v1 网关：把 Moe Memos 等第三方客户端使用的 /api/v1/* REST 路径映射到本项目已实现的
// Connect RPC（memos.api.v1.<Service>/<Method>）。上游 Memos 0.24+ 的 REST 网关响应体与
// Connect JSON 一致（无 data 包裹），因此这里只做「路径 + 参数搬运」。
//
// 注意：第三方 App 用 kotlinx.serialization 严格反序列化，多出来的字段会导致解析失败，
// 所以下面统一把响应裁剪成客户端模型里声明过的字段。
import { Hono } from 'hono'
import type { Env, Variables } from '../types'
import { ConnectError, internal } from '../v2/connect'
import { authenticate } from '../v2/auth'
import { invokeRpc, type RpcContext } from '../v2/router'

const restV1 = new Hono<{ Bindings: Env; Variables: Variables }>()

const USER_KEYS = ['name', 'role', 'username', 'email', 'displayName', 'avatarUrl', 'description', 'state', 'createTime', 'updateTime']
const MEMO_KEYS = ['name', 'state', 'creator', 'createTime', 'updateTime', 'content', 'visibility', 'pinned', 'attachments', 'tags', 'location']
const ATTACHMENT_KEYS = ['name', 'createTime', 'filename', 'externalLink', 'type', 'size', 'memo']

const pick = (obj: any, keys: string[]) => {
  if (!obj || typeof obj !== 'object') return obj
  const out: Record<string, unknown> = {}
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

async function callJson(
  c: any,
  key: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const responseHeaders = new Headers()
  try {
    const ctx: RpcContext = {
      env: c.env,
      req: c.req.raw,
      auth: await authenticate(c.req.raw, c.env),
      responseHeaders,
    }
    const result = await invokeRpc(key, body, ctx)
    return { status: 200, json: result ?? {} }
  } catch (err) {
    const connectErr =
      err instanceof ConnectError ? err : internal(err instanceof Error ? err.message : 'unknown error')
    if (!(err instanceof ConnectError)) console.error(`REST ${key} failed:`, err)
    return { status: connectErr.httpStatus, json: connectErr.toBody() }
  }
}

async function jsonBody(c: any): Promise<any> {
  const raw = await c.req.text()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** updateMask=content,visibility → ["content","visibility"] */
function parseMask(mask: string | undefined): string[] {
  if (!mask) return []
  return mask
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => p.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`))
}

const send = (c: any, r: { status: number; json: any }) => c.json(r.json, r.status as any)

// ---------- instance ----------
// MemosProfile 只有 version 一个字段，多余的键会让客户端解析失败
restV1.get('/instance/profile', async (c) => {
  const r = await callJson(c, 'memos.api.v1.InstanceService/GetInstanceProfile', {})
  if (r.status !== 200) return send(c, r)
  return c.json({ version: r.json.version ?? '0.29.1' })
})

// 0.21 风格的状态接口：{ profile: { version } }
restV1.get('/status', async (c) => {
  const r = await callJson(c, 'memos.api.v1.InstanceService/GetInstanceProfile', {})
  const version = r.status === 200 ? (r.json.version ?? '0.29.1') : '0.29.1'
  return c.json({ profile: { version } })
})

// ---------- auth ----------
restV1.get('/auth/me', async (c) => {
  const r = await callJson(c, 'memos.api.v1.AuthService/GetCurrentUser', {})
  if (r.status !== 200) return send(c, r)
  return c.json({ user: pick(r.json.user, USER_KEYS) })
})

// ---------- memos ----------
restV1.get('/memos', async (c) => {
  const q = c.req.query()
  const r = await callJson(c, 'memos.api.v1.MemoService/ListMemos', {
    pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    pageToken: q.pageToken ?? undefined,
    state: q.state ?? undefined,
    filter: q.filter ?? undefined,
    orderBy: q.orderBy ?? undefined,
  })
  if (r.status !== 200) return send(c, r)
  const memos = Array.isArray(r.json.memos) ? r.json.memos.map((m: any) => pick(m, MEMO_KEYS)) : []
  return c.json({ memos, nextPageToken: r.json.nextPageToken ?? '' })
})

restV1.post('/memos', async (c) => {
  const body = await jsonBody(c)
  const r = await callJson(c, 'memos.api.v1.MemoService/CreateMemo', { memo: body })
  if (r.status !== 200) return send(c, r)
  return c.json(pick(r.json, MEMO_KEYS))
})

restV1.get('/memos/:id', async (c) => {
  const r = await callJson(c, 'memos.api.v1.MemoService/GetMemo', { name: `memos/${c.req.param('id')}` })
  if (r.status !== 200) return send(c, r)
  return c.json(pick(r.json, MEMO_KEYS))
})

restV1.patch('/memos/:id', async (c) => {
  const id = c.req.param('id')
  const body = await jsonBody(c)
  const paths = parseMask(c.req.query('updateMask'))
  const r = await callJson(c, 'memos.api.v1.MemoService/UpdateMemo', {
    memo: { ...body, name: `memos/${id}` },
    updateMask: { paths },
  })
  if (r.status !== 200) return send(c, r)
  return c.json(pick(r.json, MEMO_KEYS))
})

restV1.delete('/memos/:id', async (c) => {
  const r = await callJson(c, 'memos.api.v1.MemoService/DeleteMemo', { name: `memos/${c.req.param('id')}` })
  return c.json({}, r.status === 200 ? 200 : r.status)
})

restV1.get('/memos/:id/comments', (c) =>
  callJson(c, 'memos.api.v1.MemoService/ListMemoComments', { name: `memos/${c.req.param('id')}` }).then((r) => send(c, { status: r.status, json: r.json })),
)

restV1.post('/memos/:id/comments', async (c) => {
  const body = await jsonBody(c)
  return callJson(c, 'memos.api.v1.MemoService/CreateMemoComment', {
    name: `memos/${c.req.param('id')}`,
    comment: body,
  }).then((r) => send(c, { status: r.status, json: r.json }))
})


// ---------- attachments ----------
restV1.get('/attachments', async (c) => {
  const q = c.req.query()
  const r = await callJson(c, 'memos.api.v1.AttachmentService/ListAttachments', {
    pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    pageToken: q.pageToken ?? undefined,
  })
  if (r.status !== 200) return send(c, r)
  const attachments = Array.isArray(r.json.attachments)
    ? r.json.attachments.map((a: any) => pick(a, ATTACHMENT_KEYS))
    : []
  return c.json({ attachments })
})

restV1.post('/attachments', async (c) => {
  try {
    const contentType = c.req.header('content-type') || ''
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ code: 'invalid_argument', message: 'expected multipart/form-data' }, 400)
    }
    const form = await c.req.formData()
    const file = form.get('file') as any
    if (!file || typeof file.arrayBuffer !== 'function') {
      return c.json({ code: 'invalid_argument', message: 'file is required' }, 400)
    }
    const buf = await file.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    const base64 = btoa(binary)
    const r = await callJson(c, 'memos.api.v1.AttachmentService/CreateAttachment', {
      attachment: {
        filename: file.name || 'upload',
        type: file.type || 'application/octet-stream',
        content: base64,
      },
    })
    if (r.status !== 200) return send(c, r)
    return c.json(pick(r.json, ATTACHMENT_KEYS))
  } catch (err) {
    console.error('REST create attachment failed:', err)
    return c.json({ code: 'internal', message: 'failed to parse upload' }, 500)
  }
})

restV1.delete('/attachments/:id', (c) => c.json({}, 200))

// ---------- users ----------
restV1.all('/users/*', async (c) => {
  const path = new URL(c.req.url).pathname
  const marker = '/users/'
  const idx = path.indexOf(marker)
  if (idx < 0) return c.json({ code: 'not_found', message: 'invalid user path' }, 404)

  let rest = decodeURIComponent(path.slice(idx + marker.length))
  let settingsKey = ''
  const settingsMatch = rest.match(/^(.*?)\/settings\/([A-Za-z_]+)$/)
  if (settingsMatch) {
    rest = settingsMatch[1]
    settingsKey = settingsMatch[2]
  }

  let method = ''
  const colon = rest.lastIndexOf(':')
  if (colon > 0) {
    method = rest.slice(colon + 1)
    rest = rest.slice(0, colon)
  }
  if (rest.startsWith('users/')) rest = rest.slice('users/'.length)

  const id = rest
  if (!id) return c.json({ code: 'not_found', message: 'user id is required' }, 404)

  if (settingsKey) {
    const r = await callJson(c, 'memos.api.v1.UserService/ListUserSettings', { parent: `users/${id}` })
    if (r.status !== 200) return send(c, r)
    const settings: any[] = r.json?.settings ?? []
    const general =
      settings.find((s) => (s?.name ?? '').endsWith(`/settings/${settingsKey}`)) ?? settings[0] ?? {}
    return c.json({
      name: general?.name ?? `users/${id}/settings/${settingsKey}`,
      generalSetting: general?.generalSetting ?? {},
    })
  }

  if (method === 'getStats') {
    const r = await callJson(c, 'memos.api.v1.UserService/GetUserStats', { name: `users/${id}` })
    if (r.status !== 200) return send(c, r)
    return c.json({
      memoTypeStats: r.json.memoTypeStats ?? {},
      tagCount: r.json.tagCount ?? {},
      memoCreatedTimestamps: r.json.memoCreatedTimestamps ?? [],
    })
  }

  const r = await callJson(c, 'memos.api.v1.UserService/GetUser', { name: `users/${id}` })
  if (r.status !== 200) return send(c, r)
  return c.json(pick(r.json, USER_KEYS))
})

export { restV1 }