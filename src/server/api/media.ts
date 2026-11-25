// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, dbKind, nullSafeEq, rawQuery } from "@/db";
import { media } from "@/db/schema";
import { can } from "../auth";
import { config } from "../config";
import { serveMedia } from "../files";
import { E, boolParam, intParam, json, readJson } from "../http";
import { collectFiles, copyToTmp, ingestOne, resolveTarget, type IngestResult } from "../media/ingest";
import { downloadToTmp } from "../media/fetch-url";
import { batchAction, getVisible, listMedia, mediaDetail, reprocessFailed, updateMedia } from "../media/service";
import { parseUpload } from "../media/upload";
import { deleteMediaByIds } from "../albums";
import { enqueue, idleIds, limiter } from "../queue";
import { hit } from "../rate";
import { route } from "../router";

/** 媒体接口:列表/搜索、详情、上传、导入、修改、删除、批量、文件输出 */

route("GET", "/media", "public", async (ctx) => {
  // 匿名搜索限流:LIKE '%词%' 是相对昂贵的查询,也是便宜的 DoS 入口(issue §6.4)
  if (!ctx.user && ctx.q.get("q")) hit(`search:${ctx.ip}`, config.searchRatePerMin);
  return listMedia({
    user: ctx.user,
    album: ctx.q.get("album"),
    q: ctx.q.get("q"),
    kind: ctx.q.get("kind"),
    recursive: boolParam(ctx.q.get("recursive"), false),
    cursor: ctx.q.get("cursor"),
    limit: intParam(ctx.q.get("limit"), 60, 1, 200),
    order: ctx.q.get("order") === "asc" ? "asc" : "desc",
    from: ctx.q.get("from"),
    to: ctx.q.get("to"),
    // 仅管理员/管理者可显式查看失败记录(用于排查);普通浏览默认过滤掉
    includeFailed: boolParam(ctx.q.get("includeFailed"), false) && !!ctx.user,
  });
});

route("GET", "/media/:id", "public", async (ctx) => mediaDetail(ctx.params.id, ctx.user, ctx.req));

route("PATCH", "/media/:id", "media.edit", async (ctx) => {
  await updateMedia(ctx.params.id, await readJson(ctx.req));
  return mediaDetail(ctx.params.id, ctx.user, ctx.req);
});

route("DELETE", "/media/:id", "media.delete", async (ctx) => {
  await getVisible(ctx.params.id, ctx.user);
  const purge = boolParam(ctx.q.get("purge"));
  // 物理删除源文件需要 media.purge(仅 admin);manager 的删除保持"排除/回收站"语义(issue §1.10)
  if (purge && !can(ctx.user, "media.purge")) throw E.forbidden("物理删除源文件需要管理员权限");
  const r = await deleteMediaByIds([ctx.params.id], purge, { user: ctx.user });
  if (r.failed.length) throw E.conflict(`记录已删除,但源文件删除失败:${r.failed[0].error}`);
  return { deleted: ctx.params.id, purge, blocked: !purge };
});

route("POST", "/media/batch", "user", async (ctx) => {
  const body = await readJson(ctx.req);
  const need = body.action === "delete" ? "media.delete" : "media.edit";
  if (!can(ctx.user, need)) throw E.forbidden(`需要权限: ${need}`);
  return batchAction(body, ctx.user!);
});

route("POST", "/media/:id/reprocess", "media.edit", async (ctx) => {
  await getVisible(ctx.params.id, ctx.user);
  await db.update(media).set({ status: "pending", error: null, attempts: 0, processingStartedMs: null }).where(eq(media.id, ctx.params.id));
  enqueue(ctx.params.id, true);
  return { queued: true };
});

route("POST", "/system/reprocess", "media.edit", async () => ({ queued: await reprocessFailed() }));

/** 重新生成全部缩略图/预览图(升级到更高清的无元数据 WebP);不改变状态,生成完成前仍显示旧图 */
route("POST", "/system/regenerate-derived", "media.edit", async () => {
  const rows = await db.select({ id: media.id }).from(media).where(eq(media.status, "ready"));
  rows.forEach((r) => enqueue(r.id));
  return { queued: rows.length };
});

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
    // 可选:等本次上传的文件处理完(只等这些 id,不被后台扫描拖住)
    if (boolParam(param("wait"), false)) {
      const ids = results.map((r) => r.id).filter((v): v is string => !!v);
      await idleIds(ids, Math.min(60_000, Math.max(1, Number(param("waitMs")) || 20_000)));
    }
    const body = { target: { album: target.album?.code ?? null, albumName: target.album?.name ?? null, storage: target.storage }, summary, results };
    // 全部失败时返回 ok:false,避免客户端按 ok 判断误以为成功(issue §3.1)
    if (!summary.created && !summary.duplicate) {
      return json(
        { ok: false, error: { code: "upload_failed", message: "所有文件都上传失败", details: body } },
        { status: 422 },
      );
    }
    return json({ ok: true, data: body });
  } catch (e) {
    // 参数错误时也要清理已写入的临时文件
    const fs = await import("node:fs/promises");
    await Promise.all(files.map((f) => fs.unlink(f.tmp).catch(() => undefined)));
    throw e;
  }
});

/**
 * 直链上传:把远端图片/视频 URL 下载后入库。
 * body: { urls: string[] | url: string, album?, storage?, duplicate?, note? }
 * 一行一个链接;支持裸域名(自动补 https://)与带空格的文件名。
 */
route("POST", "/media/upload-url", "upload", async (ctx) => {
  const b = await readJson(ctx.req);
  const raw = Array.isArray(b.urls) ? b.urls.map(String) : typeof b.url === "string" ? [b.url] : [];
  const urls = raw.map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (!urls.length) throw E.badRequest("缺少 urls");
  const target = await resolveTarget({ album: b.album as string, dir: b.dir as string, storage: b.storage as string });
  const duplicate = b.duplicate === "keep" ? "keep" : "skip";
  const note = can(ctx.user, "media.edit") && typeof b.note === "string" ? b.note : "";
  const run = limiter(Math.min(3, config.thumbConcurrency));
  const results: IngestResult[] = await Promise.all(
    urls.map((u) =>
      run(async () => {
        try {
          const tmp = await downloadToTmp(u);
          return await ingestOne(tmp, target, { user: ctx.user!, note, duplicate });
        } catch (e) {
          return { filename: u, status: "error" as const, error: String((e as Error)?.message ?? e) };
        }
      }),
    ),
  );
  const summary = {
    created: results.filter((r) => r.status === "created").length,
    duplicate: results.filter((r) => r.status === "duplicate").length,
    failed: results.filter((r) => r.status === "error").length,
  };
  const body = { target: { album: target.album?.code ?? null, albumName: target.album?.name ?? null, storage: target.storage }, summary, results };
  if (!summary.created && !summary.duplicate) {
    return json({ ok: false, error: { code: "upload_failed", message: "所有链接都下载失败", details: body } }, { status: 422 });
  }
  return json({ ok: true, data: body });
});

/** 批量查询 hash 是否已存在,供客户端做幂等同步(先查后传,issue §4.3) */
route("POST", "/media/exists", "upload", async (ctx) => {
  const b = await readJson(ctx.req);
  const hashes = Array.isArray(b.hashes) ? b.hashes.map(String).slice(0, 5000) : [];
  if (!hashes.length) throw E.badRequest("缺少 hashes");
  // 去重在服务端按「同一相册」判定:带 album(相册代码)或 dir 时只比对目标相册,
  // 否则客户端会把「已在别的相册里」的文件误判为已存在而跳过(CLI 幂等同步的前提)。
  // 不带目标时保持旧行为(全库比对)。
  const hasTarget = b.album !== undefined || b.dir !== undefined;
  let where = inArray(media.hash, hashes);
  if (hasTarget) {
    const target = await resolveTarget({ album: (b.album as string | null) ?? null, dir: (b.dir as string | null) ?? null, storage: null });
    where = and(where, nullSafeEq(media.albumId, target.album?.id ?? null)) ?? where;
  }
  const rows = await db.select({ hash: media.hash, id: media.id, albumId: media.albumId }).from(media).where(where);
  return { existing: rows.map((r) => ({ hash: r.hash, id: r.id, album: r.albumId })) };
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
  // SQLite 没有 to_char,用 substr 截取 ISO 时间串的年月
  const month = dbKind === "sqlite" ? sql`substr(sort_at, 1, 7)` : sql`to_char(sort_at, 'YYYY-MM')`;
  const rows = await rawQuery(
    sql`SELECT ${month} AS m, CAST(count(*) AS INTEGER) AS n FROM pgs_media WHERE ${cond} AND missing_at IS NULL GROUP BY 1 ORDER BY 1 DESC`,
  );
  return { months: rows.rows };
});
