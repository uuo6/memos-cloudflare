import { Hono } from "hono";
import type { Env } from "../types";
import { authMiddleware } from "../middleware/auth";

/**
 * 维护接口（管理员）：
 *   POST /api/v1/maintenance/orphans  清理「所属备忘已不存在」的孤儿附件
 *   GET  /api/v1/maintenance/orphans  只统计，不删除
 */
const maintenanceRoutes = new Hono<{ Bindings: Env }>();

maintenanceRoutes.use("*", authMiddleware);
maintenanceRoutes.use("*", async (c, next) => {
  const role = (c.get("user" as never) as { role?: string } | undefined)?.role;
  if (role && role !== "ADMIN") return c.json({ message: "Forbidden" }, 403);
  await next();
});

maintenanceRoutes.get("/orphans", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM attachment WHERE memo_id IS NULL OR memo_id NOT IN (SELECT id FROM memo)",
  ).first<{ n: number; bytes: number }>();
  return c.json({ orphans: row?.n ?? 0, bytes: row?.bytes ?? 0 });
});

maintenanceRoutes.post("/orphans", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, reference FROM attachment WHERE memo_id IS NULL OR memo_id NOT IN (SELECT id FROM memo)",
  ).all<{ id: number; reference: string }>();
  const list = rows.results ?? [];
  let removedFiles = 0;
  if (c.env.R2) {
    for (const a of list) {
      if (!a.reference) continue;
      try {
        await c.env.R2.delete(a.reference);
        removedFiles += 1;
      } catch {
        // 忽略单个失败
      }
    }
  }
  if (list.length > 0) {
    const ph = list.map(() => "?").join(",");
    await c.env.DB.prepare(`DELETE FROM attachment WHERE id IN (${ph})`).bind(...list.map((a) => a.id)).run();
  }
  return c.json({ removedRows: list.length, removedFiles });
});

/**
 * 兜底：R2 里存在、但数据库里已无对应记录的对象（例如上传中断/手工删行留下的）
 * POST /api/v1/maintenance/r2-orphans?max=500
 */
maintenanceRoutes.post("/r2-orphans", async (c) => {
  if (!c.env.R2) return c.json({ message: "R2 not configured" }, 400);
  const max = Math.min(Number(c.req.query("max") || 500), 2000);
  const db = await c.env.DB.prepare("SELECT reference FROM attachment").all<{ reference: string }>();
  const keep = new Set((db.results ?? []).map((r) => r.reference).filter(Boolean));

  const list = await c.env.R2.list({ limit: Math.min(max, 1000) });
  const removed: string[] = [];
  for (const obj of list.objects) {
    if (!keep.has(obj.key)) {
      try {
        await c.env.R2.delete(obj.key);
        removed.push(obj.key);
      } catch {
        // 忽略单个失败
      }
    }
  }
  return c.json({ scanned: list.objects.length, removed: removed.length, keys: removed.slice(0, 20) });
});
export { maintenanceRoutes };