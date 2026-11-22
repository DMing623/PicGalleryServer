import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { media } from "@/db/schema";
import { can } from "../auth";
import { config } from "../config";
import { serveMedia } from "../files";
import { E, boolParam, intParam, json, readJson } from "../http";
import { collectFiles, copyToTmp, ingestOne, resolveTarget, type IngestResult } from "../media/ingest";
import { batchAction, getVisible, listMedia, mediaDetail, reprocessFailed, updateMedia } from "../media/service";
import { parseUpload } from "../media/upload";
import { deleteMediaByIds } from "../albums";
import { enqueue, limiter } from "../queue";
import { route } from "../router";

/** 媒体接口:列表/搜索、详情、上传、导入、修改、删除、批量、文件输出 */

route("GET", "/media", "public", async (ctx) =>
  listMedia({
    user: ctx.user,
    album: ctx.q.get("album"),
    q: ctx.q.get("q"),
    kind: ctx.q.get("kind"),
    recursive: boolParam(ctx.q.get("recursive"), true),
    cursor: ctx.q.get("cursor"),
    limit: intParam(ctx.q.get("limit"), 60, 1, 200),
    order: ctx.q.get("order") === "asc" ? "asc" : "desc",
    from: ctx.q.get("from"),
    to: ctx.q.get("to"),
  }),
);

route("GET", "/media/:id", "public", async (ctx) => mediaDetail(ctx.params.id, ctx.user, ctx.req));

route("PATCH", "/media/:id", "media.edit", async (ctx) => {
  await updateMedia(ctx.params.id, await readJson(ctx.req));
  return mediaDetail(ctx.params.id, ctx.user, ctx.req);
});

route("DELETE", "/media/:id", "media.delete", async (ctx) => {
  await getVisible(ctx.params.id, ctx.user);
  await deleteMediaByIds([ctx.params.id], boolParam(ctx.q.get("purge")));
  return { deleted: ctx.params.id };
});

route("POST", "/media/batch", "user", async (ctx) => {
  const body = await readJson(ctx.req);
  const need = body.action === "delete" ? "media.delete" : "media.edit";
  if (!can(ctx.user, need)) throw E.forbidden(`需要权限: ${need}`);
  return batchAction(body, ctx.user!);
});

route("POST", "/media/:id/reprocess", "media.edit", async (ctx) => {
  await getVisible(ctx.params.id, ctx.user);
  await db.update(media).set({ status: "pending", error: null }).where(eq(media.id, ctx.params.id));
  enqueue(ctx.params.id, true);
  return { queued: true };
});

route("POST", "/system/reprocess", "media.edit", async () => ({ queued: await reprocessFailed() }));

/**
 * 上传(multipart/form-data,文件字段名任意,可多文件)。
 * 参数(query 或表单字段): album | dir | storage | concurrency | duplicate(skip|keep) | note
 */
route("POST", "/media/upload", "upload", async (ctx) => {
  const { files, fields } = await parseUpload(ctx.req);
  const param = (k: string) => ctx.q.get(k) ?? fields[k] ?? null;
  try {
    if (!files.length) throw E.badRequest("请求中没有文件");
    const target = await resolveTarget({ album: param("album"), dir: param("dir"), storage: param("storage") });
    const concurrency = intParam(param("concurrency"), 4, 1, config.thumbConcurrency);
    const duplicate = param("duplicate") === "keep" ? "keep" : "skip";
    const note = can(ctx.user, "media.edit") ? param("note") ?? "" : "";
    const run = limiter(concurrency);
    const results: IngestResult[] = await Promise.all(files.map((f) => run(() => ingestOne(f, target, { user: ctx.user!, note, duplicate }))));
    const summary = {
      created: results.filter((r) => r.status === "created").length,
      duplicate: results.filter((r) => r.status === "duplicate").length,
      failed: results.filter((r) => r.status === "error").length,
    };
    return json(
      { ok: true, data: { target: { album: target.album?.code ?? null, albumName: target.album?.name ?? null, storage: target.storage }, summary, results } },
      { status: summary.created || summary.duplicate ? 200 : 422 },
    );
  } catch (e) {
    // 参数错误时也要清理已写入的临时文件
    const fs = await import("node:fs/promises");
    await Promise.all(files.map((f) => fs.unlink(f.tmp).catch(() => undefined)));
    throw e;
  }
});

/** 服务器本地路径导入(复制): {paths:[...], album|dir|storage, recursive, concurrency, duplicate, note} */
route("POST", "/media/import", "album.mount", async (ctx) => {
  const b = await readJson(ctx.req);
  const paths = Array.isArray(b.paths) ? b.paths.map(String) : typeof b.path === "string" ? [b.path] : [];
  if (!paths.length) throw E.badRequest("缺少 paths");
  const target = await resolveTarget({ album: b.album as string, dir: b.dir as string, storage: b.storage as string });
  const list = await collectFiles(paths, b.recursive !== false);
  if (list.length > 20000) throw E.badRequest("单次导入文件过多(上限 20000)");
  const concurrency = Math.min(config.thumbConcurrency, Math.max(1, Number(b.concurrency) || 4));
  const run = limiter(concurrency);
  const results = await Promise.all(
    list.map((p) =>
      run(async () => ingestOne(await copyToTmp(p), target, { user: ctx.user!, note: typeof b.note === "string" ? b.note : "", duplicate: b.duplicate === "keep" ? "keep" : "skip" })),
    ),
  );
  return {
    target: { album: target.album?.code ?? null, storage: target.storage },
    summary: {
      created: results.filter((r) => r.status === "created").length,
      duplicate: results.filter((r) => r.status === "duplicate").length,
      failed: results.filter((r) => r.status === "error").length,
    },
    results: results.filter((r) => r.status === "error").slice(0, 200),
  };
});

/* ---------- 文件输出 ---------- */

for (const v of ["thumb", "preview", "file", "stream"] as const) {
  route("GET", `/media/:id/${v}`, "public", (ctx) => serveMedia(ctx.req, ctx.params.id, v, ctx.user));
}

/** 按时间(月)聚合,供时间轴/日期跳转使用 */
route("GET", "/media-timeline", "public", async (ctx) => {
  const { visibleIds } = await import("../albums");
  const { allowed } = await visibleIds(ctx.user);
  if (allowed && !allowed.size) return { months: [] };
  const cond = allowed ? sql`album_id IN (${sql.join([...allowed].map((i) => sql`${i}`), sql`, `)})` : sql`true`;
  const rows = await db.execute(sql`SELECT to_char(sort_at, 'YYYY-MM') AS m, count(*)::int AS n FROM pgs_media WHERE ${cond} GROUP BY 1 ORDER BY 1 DESC`);
  return { months: rows.rows };
});
