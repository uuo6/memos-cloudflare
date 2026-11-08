import { Hono } from 'hono';
import { signAttachment } from '../v2/auth';

type Env = { DB: D1Database; JWT_SECRET: string };

const memoRoutes = new Hono<{ Bindings: Env; Variables: any }>();

/** 生成与 v2 一致的 payload 附加信息，保证网页端/App 端看到相同结构 */
function buildPayload(content: string, tags: string[]) {
  const hasLink = /https?:\/\//.test(content)
  const hasTaskList = /(^|\n)\s*[-*]\s*\[[ xX]\]/.test(content)
  const hasCode = /```/.test(content)
  const hasIncompleteTasks = /(^|\n)\s*[-*]\s*\[\s\]/.test(content)
  const plain = content.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*`\-\[\]()!]/g, ' ').replace(/\s+/g, ' ').trim()
  const title = plain.slice(0, 60)
  const snippet = plain.slice(0, 120)
  return JSON.stringify({ tags, property: { hasLink, hasTaskList, hasCode, hasIncompleteTasks, title }, snippet })
}
function extractTags(content: string): string[] {
  const tags = new Set<string>();
  const re = /(?:^|\s)#([^\s#]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) tags.add(m[1]);
  return [...tags];
}

function toV0(row: any, creatorName?: string | null, resourceList: any[] = []) {
  let tags: string[] = [];
  try {
    const p = JSON.parse(row.payload || '{}');
    if (Array.isArray(p.tags)) tags = p.tags;
  } catch {}
  // 字段严格对齐 MemosV0Memo 模型
  return {
    id: row.id,
    createdTs: row.created_ts,
    creatorId: row.creator_id,
    creatorName: creatorName ?? null,
    content: row.content ?? '',
    pinned: !!row.pinned,
    rowStatus: row.row_status,
    updatedTs: row.updated_ts,
    visibility: row.visibility,
    resourceList,
  };
}

async function currentUser(c: any) {
  const payload = c.get('user');
  const row = await c.env.DB.prepare('SELECT * FROM user WHERE username = ?').bind(payload?.username || payload?.sub).first<any>();
  return row;
}

memoRoutes.get('/', async (c) => {
  try {
    const url = new URL(c.req.url);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const creatorId = url.searchParams.get('creatorId');
    const visibility = url.searchParams.get('visibility');
    const tag = url.searchParams.get('tag');
    const rowStatus = url.searchParams.get('rowStatus') || 'NORMAL';

    let sql = 'SELECT * FROM memo WHERE row_status = ?';
    const params: any[] = [rowStatus];
    if (creatorId) { sql += ' AND creator_id = ?'; params.push(Number(creatorId)); }
    if (visibility) { sql += ' AND visibility = ?'; params.push(visibility); }
    sql += ' ORDER BY pinned DESC, pinned_ts DESC, created_ts DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = await c.env.DB.prepare(sql).bind(...params).all<any>();
    const users = await c.env.DB.prepare('SELECT id, nickname, username FROM user').all<any>();
    const nameMap = new Map<number, string>();
    for (const u of users.results ?? []) nameMap.set(u.id, u.nickname || u.username);
    const ids = (rows.results ?? []).map((r: any) => r.id);
    const atts = ids.length
      ? await c.env.DB.prepare(
          `SELECT id, uid, filename, type, size, created_ts, updated_ts, creator_id, memo_id FROM attachment WHERE memo_id IN (${ids.map(() => '?').join(',')})`,
        ).bind(...ids).all<any>()
      : { results: [] as any[] };
    const byMemo = new Map<number, any[]>();
    for (const a of (atts.results ?? []) as any[]) {
      const list = byMemo.get(a.memo_id) ?? [];
      const sig = await signAttachment(c.env as any, a.uid);
      list.push({
        id: a.id,
        uid: a.uid,
        filename: a.filename,
        type: a.type,
        size: a.size,
        createdTs: a.created_ts,
        updatedTs: a.updated_ts,
        creatorId: a.creator_id,
        externalLink: `${new URL(c.req.url).origin}/file/attachments/${a.uid}/${encodeURIComponent(a.filename)}?sig=${sig}`,
        publicId: null,
        name: null,
      });
      byMemo.set(a.memo_id, list);
    }
    let memos = (rows.results ?? []).map((r: any) => toV0(r, nameMap.get(r.creator_id), byMemo.get(r.id) ?? []));
    if (tag) memos = memos.filter((m: any) => m.tags.includes(tag));
    return c.json(memos);
  } catch (error: any) {
    console.error('List memos error:', error);
    return c.json({ message: 'Internal server error' }, 500);
  }
});

memoRoutes.get('/all', async (c) => {
  try {
    const url = new URL(c.req.url);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const visibility = url.searchParams.get('visibility');
    const pinnedRaw = url.searchParams.get('pinned');
    const tag = url.searchParams.get('tag');

    // 「发现/公开」场景：未显式指定 creatorId 时，一律只暴露公开或受保护内容，避免私有备忘外泄
    const creatorId = url.searchParams.get('creatorId');
    const rowStatusParam = url.searchParams.get('rowStatus') || 'NORMAL';
    let sql = `SELECT * FROM memo WHERE row_status = ?`;
    const params: any[] = [rowStatusParam];
    if (visibility) {
      sql += ' AND visibility = ?'; params.push(visibility);
    } else if (!creatorId) {
      sql += " AND visibility IN ('PUBLIC','PROTECTED')";
    }
    if (creatorId) { sql += ' AND creator_id = ?'; params.push(Number(creatorId)); }
    if (pinnedRaw === 'true' || pinnedRaw === 'false') { sql += ' AND pinned = ?'; params.push(pinnedRaw === 'true' ? 1 : 0); }
    sql += ' ORDER BY pinned DESC, pinned_ts DESC, created_ts DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = await c.env.DB.prepare(sql).bind(...params).all<any>();
    const users = await c.env.DB.prepare('SELECT id, nickname, username FROM user').all<any>();
    const nameMap = new Map<number, string>();
    for (const u of users.results ?? []) nameMap.set(u.id, u.nickname || u.username);

    const ids = (rows.results ?? []).map((r: any) => r.id);
    const atts = ids.length
      ? await c.env.DB.prepare(
          `SELECT id, uid, filename, type, size, created_ts, updated_ts, creator_id, memo_id FROM attachment WHERE memo_id IN (${ids.map(() => '?').join(',')})`,
        ).bind(...ids).all<any>()
      : { results: [] as any[] };
    const origin = new URL(c.req.url).origin;
    const byMemo = new Map<number, any[]>();
    for (const a of (atts.results ?? []) as any[]) {
      const list = byMemo.get(a.memo_id) ?? [];
      list.push({
        id: a.id,
        uid: a.uid,
        filename: a.filename,
        type: a.type,
        size: a.size,
        createdTs: a.created_ts,
        updatedTs: a.updated_ts,
        creatorId: a.creator_id,
        externalLink: `${origin}/file/attachments/${a.uid}/${encodeURIComponent(a.filename)}?sig=${await signAttachment(c.env as any, a.uid)}`,
        publicId: null,
        name: null,
      });
      byMemo.set(a.memo_id, list);
    }

    let memos = (rows.results ?? []).map((r: any) => toV0(r, nameMap.get(r.creator_id), byMemo.get(r.id) ?? []));
    if (tag) memos = memos.filter((m: any) => (m.content || '').includes(`#${tag}`));
    return c.json(memos);
  } catch (error: any) {
    console.error('List all memos error:', error);
    return c.json({ message: 'Internal server error' }, 500);
  }
});

memoRoutes.get('/stats', async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS total FROM memo WHERE row_status = 'NORMAL'").first<any>();
  return c.json({ total: row?.total ?? 0 });
});

memoRoutes.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM memo WHERE id = ?').bind(Number(c.req.param('id'))).first<any>();
  if (!row) return c.json({ message: 'Memo not found' }, 404);
  return c.json(toV0(row));
});

memoRoutes.post('/', async (c) => {
  try {
    const user = await currentUser(c);
    if (!user) return c.json({ message: 'Unauthorized' }, 401);
    const body = await c.req.json().catch(() => ({}) as any);
    const content = String(body.content ?? '');
    const now = Math.floor(Date.now() / 1000);
    const createdTs = Number(body.createdTs ?? now);
    const uid = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const visibility = body.visibility ?? 'PRIVATE';
    const pinned = body.pinned ? 1 : 0;
    const tags = extractTags(content);
    const payload = buildPayload(content, tags);
    const res = await c.env.DB.prepare(
      'INSERT INTO memo (uid, creator_id, created_ts, updated_ts, row_status, content, visibility, pinned, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(uid, user.id, createdTs, now, 'NORMAL', content, visibility, pinned, payload).run();
    const id = Number(res.meta?.last_row_id);
    const resourceIds: number[] = Array.isArray(body.resourceIdList) ? body.resourceIdList.map(Number).filter(Number.isFinite) : [];
    if (resourceIds.length) {
      await c.env.DB.prepare(
        `UPDATE attachment SET memo_id = ? WHERE id IN (${resourceIds.map(() => '?').join(',')})`,
      ).bind(id, ...resourceIds).run();
    }
    const row = await c.env.DB.prepare('SELECT * FROM memo WHERE id = ?').bind(id).first<any>();
    const atts = await c.env.DB.prepare(
      'SELECT id, uid, filename, type, size, created_ts, updated_ts, creator_id FROM attachment WHERE memo_id = ?',
    ).bind(id).all<any>();
    const origin = new URL(c.req.url).origin;
    const resourceList = await Promise.all((atts.results ?? []).map(async (a: any) => ({
      id: a.id, uid: a.uid, filename: a.filename, type: a.type, size: a.size,
      createdTs: a.created_ts, updatedTs: a.updated_ts, creatorId: a.creator_id,
      externalLink: `${origin}/file/attachments/${a.uid}/${encodeURIComponent(a.filename)}?sig=${await signAttachment(c.env as any, a.uid)}`,
      publicId: null, name: null,
    })));
    return c.json(toV0(row, null, resourceList));
  } catch (error: any) {
    console.error('Create memo error:', error);
    return c.json({ message: 'Internal server error' }, 500);
  }
});

memoRoutes.patch('/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}) as any);
    const sets: string[] = [];
    const params: any[] = [];
    if (typeof body.content === 'string') {
      sets.push('content = ?'); params.push(body.content);
      sets.push('payload = ?'); params.push(buildPayload(body.content, extractTags(body.content)));
    }
    if (body.visibility) { sets.push('visibility = ?'); params.push(body.visibility); }
    if (body.rowStatus) { sets.push('row_status = ?'); params.push(body.rowStatus); }
    if (typeof body.pinned === 'boolean') {
      sets.push('pinned = ?'); params.push(body.pinned ? 1 : 0);
      if (body.pinned) { sets.push('pinned_ts = ?'); params.push(Math.floor(Date.now() / 1000)); } else { sets.push('pinned_ts = NULL'); }
    }
    const resourceIds: number[] = Array.isArray(body.resourceIdList)
      ? body.resourceIdList.map(Number).filter(Number.isFinite)
      : [];
    if (!sets.length && !resourceIds.length) return c.json({ message: 'nothing to update' }, 400);
    if (sets.length) {
      sets.push('updated_ts = ?'); params.push(Math.floor(Date.now() / 1000));
      await c.env.DB.prepare(`UPDATE memo SET ${sets.join(', ')} WHERE id = ?`).bind(...params, id).run();
    }
    if (Array.isArray(body.resourceIdList)) {
      // 先解绑，再按最新列表绑定
      await c.env.DB.prepare('UPDATE attachment SET memo_id = NULL WHERE memo_id = ?').bind(id).run();
      if (resourceIds.length) {
        await c.env.DB.prepare(
          `UPDATE attachment SET memo_id = ? WHERE id IN (${resourceIds.map(() => '?').join(',')})`,
        ).bind(id, ...resourceIds).run();
      }
    }
    const row = await c.env.DB.prepare('SELECT * FROM memo WHERE id = ?').bind(id).first<any>();
    const atts = await c.env.DB.prepare(
      'SELECT id, uid, filename, type, size, created_ts, updated_ts, creator_id FROM attachment WHERE memo_id = ?',
    ).bind(id).all<any>();
    const origin = new URL(c.req.url).origin;
    const resourceList = await Promise.all((atts.results ?? []).map(async (a: any) => ({
      id: a.id, uid: a.uid, filename: a.filename, type: a.type, size: a.size,
      createdTs: a.created_ts, updatedTs: a.updated_ts, creatorId: a.creator_id,
      externalLink: `${origin}/file/attachments/${a.uid}/${encodeURIComponent(a.filename)}?sig=${await signAttachment(c.env as any, a.uid)}`,
      publicId: null, name: null,
    })));
    return c.json(toV0(row, null, resourceList));
  } catch (error: any) {
    console.error('Patch memo error:', error);
    return c.json({ message: 'Internal server error' }, 500);
  }
});

memoRoutes.post('/:id/organizer', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}) as any);
    const nowTs = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare('UPDATE memo SET pinned = ?, pinned_ts = ?, updated_ts = ? WHERE id = ?')
      .bind(body.pinned ? 1 : 0, body.pinned ? nowTs : null, nowTs, id)
      .run();
    // 客户端会把响应体当作 MemosV0Memo 解析，必须返回完整对象
    const row = await c.env.DB.prepare('SELECT * FROM memo WHERE id = ?').bind(id).first<any>();
    if (!row) return c.json({ message: 'Memo not found' }, 404);
    return c.json(toV0(row));
  } catch (error: any) {
    console.error('Organizer error:', error);
    return c.json({ message: 'Internal server error' }, 500);
  }
});

memoRoutes.delete('/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    // 级联清理：附件（先删 R2 文件，再删记录）、关系、分享，最后删备忘
    const atts = await c.env.DB.prepare('SELECT reference FROM attachment WHERE memo_id = ?').bind(id).all<{ reference: string }>();
    if (c.env.R2) {
      for (const a of atts.results ?? []) {
        if (a.reference) { try { await c.env.R2.delete(a.reference); } catch {} }
      }
    }
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM attachment WHERE memo_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM memo_share WHERE memo_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM memo_relation WHERE memo_id = ? OR related_memo_id = ?').bind(id, id),
      c.env.DB.prepare('DELETE FROM memo WHERE id = ?').bind(id),
    ]);
    return c.json({});
  } catch (error: any) {
    return c.json({ message: 'Internal server error' }, 500);
  }
});

export { memoRoutes };