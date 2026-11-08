import { Hono } from 'hono';
import { authenticate, signAttachment } from '../v2/auth';
import { invokeRpc } from '../v2/router';

type Env = { DB: D1Database; JWT_SECRET: string; R2?: R2Bucket };

const resourceRoutes = new Hono<{ Bindings: Env; Variables: any }>();

async function toV0Resource(c: any, a: any) {
  const origin = new URL(c.req.url).origin;
  const sig = await signAttachment(c.env as any, a.uid);
  return {
    id: a.id,
    createdTs: a.created_ts,
    creatorId: a.creator_id,
    filename: a.filename,
    size: a.size,
    type: a.type,
    updatedTs: a.updated_ts,
    externalLink: `${origin}/file/attachments/${a.uid}/${encodeURIComponent(a.filename)}?sig=${sig}`,
    publicId: null,
    name: null,
    uid: a.uid,
  };
}

resourceRoutes.get('/', async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      'SELECT id, uid, filename, type, size, created_ts, updated_ts, creator_id FROM attachment ORDER BY id DESC LIMIT 200',
    ).all<any>();
    return c.json(await Promise.all((rows.results ?? []).map((a: any) => toV0Resource(c, a))));
  } catch (error: any) {
    console.error('List resources error:', error);
    return c.json([]);
  }
});

// 0.21 的上传接口：multipart/form-data，字段名 file
resourceRoutes.post('/blob', async (c) => {
  try {
    const contentType = c.req.header('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ message: 'expected multipart/form-data' }, 400);
    }
    const form = await c.req.formData();
    const file = form.get('file') as any;
    if (!file || typeof file.arrayBuffer !== 'function') {
      return c.json({ message: 'file is required' }, 400);
    }
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);

    const ctx = {
      env: c.env as any,
      req: c.req.raw,
      auth: await authenticate(c.req.raw, c.env as any),
      responseHeaders: new Headers(),
    };
    const created: any = await invokeRpc(
      'memos.api.v1.AttachmentService/CreateAttachment',
      {
        attachment: {
          filename: file.name || 'upload',
          type: file.type || 'application/octet-stream',
          content: btoa(binary),
        },
      },
      ctx as any,
    );

    const uid = String(created?.name || '').split('/').pop();
    // 部分客户端上传时直接带 memo 字段（备忘 id）
    const memoField = form.get('memo');
    if (memoField) {
      const memoId = Number(String(memoField).split('/').pop());
      if (Number.isFinite(memoId)) {
        await c.env.DB.prepare('UPDATE attachment SET memo_id = ? WHERE uid = ?').bind(memoId, uid).run();
      }
    }
    const row = await c.env.DB.prepare('SELECT * FROM attachment WHERE uid = ?').bind(uid).first<any>();
    if (!row) return c.json({ message: 'attachment not found after upload' }, 500);
    return c.json(await toV0Resource(c, row));
  } catch (error: any) {
    console.error('Upload resource error:', error);
    return c.json({ message: error?.message || 'Internal server error' }, 500);
  }
});

resourceRoutes.delete('/:id', async (c) => {
  try {
    await c.env.DB.prepare('DELETE FROM attachment WHERE id = ?').bind(Number(c.req.param('id'))).run();
    return c.json({});
  } catch {
    return c.json({});
  }
});

export { resourceRoutes };