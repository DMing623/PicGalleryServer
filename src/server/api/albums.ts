// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import {
  albumDetail, albumStatus, browseDirs, createManaged, deleteAlbum, listAlbums, mountDir, scanAlbum, scanStates, loadTree,
  unsortedCount, updateAlbum, visibleIds,
} from "../albums";
import { E, boolParam, readJson } from "../http";
import { route } from "../router";

/** 相册分类接口 */

route("GET", "/albums", "public", async (ctx) => {
  const parent = ctx.q.get("parent");
  const list = await listAlbums(ctx.user, parent === null ? undefined : parent === "" || parent === "root" ? null : parent);
  if (ctx.q.get("tree") === "1") {
    // 平铺 → 嵌套树
    const flat = ctx.q.has("parent") ? list : await listAlbums(ctx.user);
    const byCode = new Map(flat.map((a) => [a.code, { ...a, children: [] as unknown[] }]));
    const roots: unknown[] = [];
    for (const a of byCode.values()) {
      const p = a.parent ? byCode.get(a.parent) : undefined;
      (p ? p.children : roots).push(a);
    }
    return { albums: roots };
  }
  const { allowed } = await visibleIds(ctx.user);
  return { albums: list, unsorted: ctx.user && !allowed ? await unsortedCount() : null };
});

route("POST", "/albums", "album.manage", async (ctx) => {
  const b = await readJson(ctx.req);
  const code = await createManaged({
    name: b.name, parent: (b.parent as string) || null, visibility: b.visibility, description: b.description, storage: b.storage,
    sortOrder: b.sortOrder,
  });
  return new Response(JSON.stringify({ ok: true, data: await albumDetail(code, ctx.user) }), {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
});

route("POST", "/albums/mount", "album.mount", async (ctx) => {
  const b = await readJson(ctx.req);
  const code = await mountDir({
    path: b.path, name: b.name, parent: (b.parent as string) || null, recursive: b.recursive !== false, visibility: b.visibility,
    scan: b.scan !== false,
  });
  return new Response(JSON.stringify({ ok: true, data: await albumDetail(code, ctx.user) }), {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
});

route("GET", "/fs/browse", "album.mount", async (ctx) => browseDirs(ctx.q.get("path") ?? "/"));

route("GET", "/albums/:code", "public", async (ctx) => albumDetail(ctx.params.code, ctx.user));

route("GET", "/albums/:code/status", "public", async (ctx) => albumStatus(ctx.params.code, ctx.user));

route("PATCH", "/albums/:code", "album.manage", async (ctx) => {
  await updateAlbum(ctx.params.code, await readJson(ctx.req));
  return albumDetail(ctx.params.code, ctx.user);
});

route("DELETE", "/albums/:code", "album.manage", async (ctx) => {
  const mode = ctx.q.get("media") === "delete" ? "delete" : "move";
  const purge = boolParam(ctx.q.get("purge"));
  const t = await loadTree();
  const a = t.byCode.get(ctx.params.code);
  if (a?.kind === "mounted" && ctx.user?.role !== "admin") throw E.forbidden("只有管理员可以移除挂载相册");
  await deleteAlbum(ctx.params.code, { media: mode, purge });
  return { deleted: ctx.params.code };
});

route("POST", "/albums/:code/scan", "album.mount", async (ctx) => {
  const recursive = boolParam(ctx.q.get("recursive"), true);
  const p = scanAlbum(ctx.params.code, recursive);
  if (boolParam(ctx.q.get("wait"))) return p;
  p.catch((e) => console.error("[scan]", e));
  await new Promise((r) => setTimeout(r, 30));
  const t = await loadTree();
  const a = t.byCode.get(ctx.params.code);
  return { started: true, state: a ? scanStates.get(a.id) ?? null : null };
});
