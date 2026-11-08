import { Hono } from 'hono';

type Env = { DB: D1Database; JWT_SECRET: string };

const tagRoutes = new Hono<{ Bindings: Env; Variables: any }>();

// 从 memo.payload 里解析 tags（v2 schema 没有独立 tag 表）
async function collectTags(db: D1Database): Promise<{ name: string; count: number }[]> {
  const rows = await db.prepare("SELECT payload FROM memo WHERE row_status = 'NORMAL'").all<any>();
  const counter = new Map<string, number>();
  for (const row of rows.results ?? []) {
    let tags: string[] = [];
    try {
      const payload = JSON.parse(row.payload || '{}');
      if (Array.isArray(payload.tags)) tags = payload.tags;
    } catch {}
    for (const tag of tags) counter.set(tag, (counter.get(tag) ?? 0) + 1);
  }
  return [...counter.entries()].map(([name, count]) => ({ name, count }));
}

tagRoutes.get('/', async (c) => {
  try {
    return c.json(await collectTags(c.env.DB));
  } catch (error: any) {
    console.error('List tags error:', error);
    return c.json({ message: 'Internal server error' }, 500);
  }
});

tagRoutes.post('/', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    return c.json({ name: body?.name ?? '' });
  } catch {
    return c.json({ message: 'Internal server error' }, 500);
  }
});

tagRoutes.delete('/:id', (c) => c.json({}));

export { tagRoutes };