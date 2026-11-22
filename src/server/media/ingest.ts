import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { albums, media } from "@/db/schema";
import { invalidateAlbums, loadTree, assertMountAllowed, type AlbumRow } from "../albums";
import type { AuthUser } from "../auth";
import { dirs } from "../config";
import { E } from "../http";
import { enqueue } from "../queue";
import { driverFor, isStorageCode, moveFile, s3Available, type StorageCode } from "../storage";
import { hintLocalCopy } from "./derive";
import { detectKind, randomId, safeName } from "./types";
import type { UploadedTmp } from "./upload";

/**
 * 入库流程: 临时文件 → 去重 → 放入目标存储 → 写 pending 记录 → 入队生成派生图/元数据。
 * 目标由 resolveTarget 决定:
 *   album=<相册代码>  : 受管相册 → 相册自身的存储(local/s3); 挂载相册 → 写入该目录
 *   dir=<绝对路径>    : 必须位于某个挂载相册的根目录内,不存在的子目录会自动创建并生成嵌套子相册
 *   均未指定           : 未归类收件箱(albums/_inbox),storage 参数决定 local 或 s3
 */

export interface IngestTarget {
  album: AlbumRow | null;
  storage: StorageCode;
  /** local/s3: 键前缀; ext: 绝对目录 */
  dirKey: string;
}

export async function resolveTarget(p: { album?: string | null; dir?: string | null; storage?: string | null }): Promise<IngestTarget> {
  const wantStorage = p.storage ? p.storage : null;
  if (wantStorage && !isStorageCode(wantStorage)) throw E.badRequest("storage 只能是 local | s3 | ext");
  const t = await loadTree();

  if (p.dir) {
    const abs = path.resolve(p.dir);
    assertMountAllowed(abs);
    const roots = t.rows
      .filter((a) => a.kind === "mounted" && a.rootPath && (abs === a.rootPath || abs.startsWith(a.rootPath + path.sep)))
      .sort((a, b) => b.rootPath!.length - a.rootPath!.length);
    let cur = roots[0];
    if (!cur) throw E.badRequest("dir 不在任何已挂载的相册目录内,请先挂载", "dir_not_mounted");
    const rel = path.relative(cur.rootPath!, abs);
    if (rel) {
      let walk = cur.rootPath!;
      for (const seg of rel.split(path.sep)) {
        walk = path.join(walk, seg);
        await fs.mkdir(walk, { recursive: true });
        const tree = await loadTree();
        let child = (tree.children.get(cur.id) ?? []).find((c) => c.rootPath === walk);
        if (!child) {
          const [created] = await db
            .insert(albums)
            .values({ id: randomId(14), code: `dir_${randomId(8)}`, name: seg, parentId: cur.id, kind: "mounted", storage: "ext", rootPath: walk, visibility: cur.visibility })
            .returning();
          child = created;
          invalidateAlbums();
        }
        cur = child;
      }
    }
    if (wantStorage && wantStorage !== "ext") throw E.badRequest("dir 目标的 storage 固定为 ext");
    return { album: cur, storage: "ext", dirKey: cur.rootPath! };
  }

  if (p.album) {
    const a = t.byCode.get(p.album);
    if (!a) throw E.notFound(`相册不存在: ${p.album}`);
    if (a.kind === "mounted") {
      if (wantStorage && wantStorage !== "ext") throw E.badRequest("挂载相册的 storage 固定为 ext");
      return { album: a, storage: "ext", dirKey: a.rootPath! };
    }
    const st = a.storage as StorageCode;
    if (wantStorage && wantStorage !== st) throw E.badRequest(`该相册的存储代码是 ${st},与 storage=${wantStorage} 不一致`);
    return { album: a, storage: st, dirKey: `albums/${a.code}` };
  }

  const st = (wantStorage ?? "local") as StorageCode;
  if (st === "ext") throw E.badRequest("未指定相册时 storage 只能是 local 或 s3");
  if (st === "s3" && !s3Available()) throw E.badRequest("未配置对象存储", "s3_not_configured");
  return { album: null, storage: st, dirKey: "albums/_inbox" };
}

async function uniqueKey(storage: StorageCode, dirKey: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const driver = await driverFor(storage);
  for (let i = 0; i < 20; i++) {
    const n = i === 0 ? name : `${stem}-${randomBytes(2).toString("hex")}${ext}`;
    const key = storage === "ext" ? path.join(dirKey, n) : `${dirKey}/${n}`;
    const [dup] = await db.select({ id: media.id }).from(media).where(and(eq(media.storage, storage), eq(media.storageKey, key))).limit(1);
    if (dup) continue;
    if (storage !== "s3" && (await driver.stat(key))) continue;
    return key;
  }
  throw E.conflict("无法生成唯一文件名");
}

export interface IngestResult {
  filename: string;
  status: "created" | "duplicate" | "error";
  id?: string;
  album?: string | null;
  storage?: string;
  link?: string;
  error?: string;
}

export async function ingestOne(
  file: UploadedTmp,
  target: IngestTarget,
  opts: { user: AuthUser; note?: string; duplicate: "skip" | "keep" },
): Promise<IngestResult> {
  const result: IngestResult = { filename: file.name, status: "error" };
  let consumed = false;
  let keepTmp = false;
  try {
    if (file.truncated) throw new Error("文件超过 MAX_UPLOAD_MB 限制");
    const kind = detectKind(file.name);
    if (!kind) throw new Error("不支持的文件类型");
    if (file.size === 0) throw new Error("空文件");

    if (opts.duplicate === "skip") {
      const [dup] = await db
        .select({ id: media.id })
        .from(media)
        .where(and(eq(media.hash, file.hash), sql`${media.albumId} IS NOT DISTINCT FROM ${target.album?.id ?? null}`))
        .limit(1);
      if (dup) return { ...result, status: "duplicate", id: dup.id, link: `/f/${dup.id}`, album: target.album?.code ?? null };
    }

    const name = safeName(file.name);
    const key = await uniqueKey(target.storage, target.dirKey, name);
    const driver = await driverFor(target.storage);
    const id = randomId(12);
    await driver.put(key, file.tmp, kind.mime);
    consumed = target.storage !== "s3";
    if (target.storage === "s3") {
      hintLocalCopy(id, file.tmp);
      keepTmp = true; // 派生任务完成后会清理该临时副本
    }

    const note = (opts.note ?? "").slice(0, 5000);
    await db.insert(media).values({
      id, albumId: target.album?.id ?? null, kind: kind.kind, filename: path.basename(key), mime: kind.mime, size: file.size,
      hash: file.hash, sortAt: new Date(), storage: target.storage, storageKey: key, status: "pending", note,
      searchText: `${path.basename(key)}\n${note}`.toLowerCase(), uploadedBy: opts.user.id,
    });
    invalidateAlbums();
    enqueue(id, true);
    return { filename: file.name, status: "created", id, link: `/f/${id}`, album: target.album?.code ?? null, storage: target.storage };
  } catch (e) {
    return { ...result, error: String((e as Error).message ?? e) };
  } finally {
    if (!consumed && !keepTmp) await fs.unlink(file.tmp).catch(() => undefined);
  }
}

/** 服务器本地路径导入(复制到目标): paths 可含文件或目录 */
export async function collectFiles(paths: string[], recursive: boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (p: string, depth: number) => {
    const st = await fs.stat(p).catch(() => null);
    if (!st) return;
    if (st.isFile()) {
      if (detectKind(p)) out.push(p);
    } else if (st.isDirectory() && depth < 12) {
      for (const e of await fs.readdir(p)) {
        if (e.startsWith(".")) continue;
        const child = path.join(p, e);
        if (recursive || !(await fs.stat(child).catch(() => null))?.isDirectory()) await walk(child, depth + 1);
      }
    }
  };
  for (const p of paths) {
    const abs = path.resolve(p);
    assertMountAllowed(abs);
    await walk(abs, 0);
  }
  return out;
}

export async function copyToTmp(src: string): Promise<UploadedTmp> {
  await fs.mkdir(dirs.tmp, { recursive: true });
  const tmp = path.join(dirs.tmp, `imp-${randomBytes(8).toString("hex")}`);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(src);
    rs.on("data", (c) => hash.update(c));
    rs.on("error", reject);
    rs.on("end", resolve);
  });
  await fs.copyFile(src, tmp);
  const st = await fs.stat(tmp);
  return { name: path.basename(src), mime: detectKind(src)?.mime ?? "application/octet-stream", tmp, size: st.size, hash: hash.digest("hex"), truncated: false };
}

export { moveFile };
