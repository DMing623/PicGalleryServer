"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import Link from "next/link";
import { memo, Suspense, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { bytes } from "@/lib/format";
import AlbumActions, { type AlbumDto } from "./AlbumActions";
import { navigateApp, useApp } from "./AppProvider";
import { useDialog } from "./DialogProvider";
import Gallery from "./Gallery";

interface Detail extends AlbumDto {
  breadcrumbs: Array<{ code: string; name: string }>;
  children: AlbumDto[];
}

interface RootAlbumsCache {
  userId: string | null;
  albums: AlbumDto[];
  unsorted: number | null;
}

/** 会话级相册列表与详情缓存:切换相册页或进入子相册时首帧即刻展示,后台静默刷新 */
let rootCache: RootAlbumsCache | null = null;
const detailCache = new Map<string, Detail>();

function onAlbumLinkClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  navigateApp(href);
}

const Card = memo(function Card({ a, showManage }: { a: AlbumDto; showManage: boolean }) {
  const href = `/albums/${a.code}`;
  return (
    <Link href={href} onClick={(e) => onAlbumLinkClick(e, href)} className="tile glass group block overflow-hidden rounded-2xl">
      <div className="relative aspect-[4/3] w-full overflow-hidden" style={{ background: "linear-gradient(135deg, var(--bg2), color-mix(in srgb, var(--accent) 25%, var(--bg)))" }}>
        {a.coverId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/v1/media/${a.coverId}/thumb`}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-4xl opacity-60">📁</div>
        )}
        {showManage && (
          <span className="absolute left-2 top-2 flex gap-1">
            <span className="chip" style={{ background: "rgba(0,0,0,.5)", color: "#fff" }}>{a.visibility === "public" ? "公开" : "私有"}</span>
            {a.kind === "mounted" && <span className="chip" style={{ background: "rgba(0,0,0,.5)", color: "#fff" }}>目录</span>}
          </span>
        )}
      </div>
      <div className="p-3">
        <div className="truncate font-medium">{a.name}</div>
        <div className="muted mt-0.5 text-xs">
          {a.counts.mediaTotal} 项 · {bytes(a.counts.sizeTotal)}
          {a.counts.children > 0 && ` · ${a.counts.children} 个子相册`}
        </div>
      </div>
    </Link>
  );
});

export default function AlbumsView({ code, active = true }: { code?: string; active?: boolean }) {
  const { loading, can, me } = useApp();
  const dlg = useDialog();
  const userId = me?.user?.id ?? null;
  const [detail, setDetail] = useState<Detail | null>(() => (code && code !== "_unsorted" ? detailCache.get(code) ?? null : null));
  const [list, setList] = useState<AlbumDto[] | null>(() => (!code && rootCache && rootCache.userId === userId ? rootCache.albums : null));
  const [unsorted, setUnsorted] = useState<number | null>(() => (!code && rootCache && rootCache.userId === userId ? rootCache.unsorted : null));
  const [err, setErr] = useState("");
  const showManage = can("album.manage");

  const load = useCallback(async () => {
    try {
      if (code === "_unsorted") return;
      if (code) {
        const d = await api<Detail>(`/albums/${code}`);
        detailCache.set(code, d);
        for (const c of d.children) {
          if (!detailCache.has(c.code)) {
            detailCache.set(c.code, {
              ...c,
              breadcrumbs: [...d.breadcrumbs, { code: c.code, name: c.name }],
              children: [],
            });
          }
        }
        setDetail(d);
      } else {
        const r = await api<{ albums: AlbumDto[]; unsorted: number | null }>("/albums?parent=root");
        rootCache = { userId, albums: r.albums, unsorted: r.unsorted };
        for (const a of r.albums) {
          if (!detailCache.has(a.code)) {
            detailCache.set(a.code, { ...a, breadcrumbs: [{ code: a.code, name: a.name }], children: [] });
          }
        }
        setList(r.albums);
        setUnsorted(r.unsorted);
      }
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [code, userId]);

  useEffect(() => {
    if (loading) return;
    void load();
    const h = () => void load();
    window.addEventListener("pgs:albums", h);
    return () => window.removeEventListener("pgs:albums", h);
  }, [load, loading, userId]);

  if (code === "_unsorted") {
    return (
      <div>
        <h1 className="mb-2 px-2 text-lg font-semibold">未归类(收件箱)</h1>
        <Suspense fallback={null}><Gallery album="_unsorted" active={active} /></Suspense>
      </div>
    );
  }

  if (err) {
    return (
      <div className="glass mx-auto mt-10 max-w-md rounded-3xl p-10 text-center">
        <p className="font-medium">{err}</p>
        <Link href="/albums" onClick={(e) => onAlbumLinkClick(e, "/albums")} className="btn mt-4">返回相册列表</Link>
      </div>
    );
  }

  if (!code) {
    return (
      <div className="px-2">
        <div className="mb-3 flex items-center gap-3">
          <h1 className="text-lg font-semibold">相册</h1>
          {showManage && (
            <button
              className="btn btn-primary !py-1 text-xs"
              onClick={async () => {
                const name = await dlg.prompt({ title: "新建相册", label: "相册名称", placeholder: "例如:旅行", confirmText: "创建", validate: (v) => (v ? (v.length > 80 ? "名称过长(最多 80 字)" : null) : "请输入相册名称") });
                if (!name) return;
                try {
                  await api("/albums", { method: "POST", json: { name, visibility: "private" } });
                  await load();
                } catch (e) {
                  await dlg.alert((e as Error).message, "创建失败");
                }
              }}
            >
              ＋ 新建相册
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {unsorted !== null && (
            <Link href="/albums/_unsorted" onClick={(e) => onAlbumLinkClick(e, "/albums/_unsorted")} className="tile glass group block overflow-hidden rounded-2xl">
              <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden" style={{ background: "linear-gradient(135deg, var(--bg2), color-mix(in srgb, var(--accent) 25%, var(--bg)))" }}>
                <span className="text-4xl opacity-60">📥</span>
              </div>
              <div className="p-3">
                <div className="truncate font-medium">未归类</div>
                <div className="muted mt-0.5 text-xs">{unsorted} 项</div>
              </div>
            </Link>
          )}
          {list?.map((a) => <Card key={a.code} a={a} showManage={showManage} />)}
        </div>
        {list && list.length === 0 && (
          <div className="glass mx-auto mt-10 max-w-md rounded-3xl p-10 text-center">
            <div className="text-4xl">📁</div>
            <p className="mt-2 font-medium">暂无可见相册</p>
            <p className="muted mt-1 text-sm">{me?.user ? "点击「新建相册」或到设置中挂载服务器目录" : "管理员尚未开放任何相册"}</p>
          </div>
        )}
      </div>
    );
  }

  if (!detail) return <p className="muted py-10 text-center text-sm">加载中…</p>;

  return (
    <div>
      <div className="glass mx-2 mb-3 rounded-2xl p-3">
        <nav className="muted mb-1 flex flex-wrap items-center gap-1 text-sm">
          <Link href="/albums" onClick={(e) => onAlbumLinkClick(e, "/albums")} className="hover:underline">相册</Link>
          {detail.breadcrumbs.map((b) => (
            <span key={b.code}>
              / <Link href={`/albums/${b.code}`} onClick={(e) => onAlbumLinkClick(e, `/albums/${b.code}`)} className="hover:underline">{b.name}</Link>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{detail.name}</h1>
          {showManage && (
            <>
              <span className="chip">{detail.visibility === "public" ? "公开" : "私有"}</span>
              <span className="chip">{detail.kind === "mounted" ? "挂载目录" : detail.storage === "s3" ? "受管 · S3" : "受管 · 本地"}</span>
            </>
          )}
          <span className="muted text-sm">{detail.counts.mediaTotal} 项 · {bytes(detail.counts.sizeTotal)}</span>
          <div className="ml-auto">
            <AlbumActions album={detail} onChanged={load} onDeleted={() => navigateApp(detail.parent ? `/albums/${detail.parent}` : "/albums")} />
          </div>
        </div>
        {detail.rootPath && <p className="muted mt-1 break-all text-xs">📂 {detail.rootPath}</p>}
        {detail.description && <p className="mt-2 text-sm">{detail.description}</p>}
      </div>

      {detail.children.length > 0 && (
        <div className="mx-2 mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-7">
          {detail.children.map((a) => <Card key={a.code} a={a} showManage={showManage} />)}
        </div>
      )}
      <Suspense fallback={null}>
        <Gallery album={code} active={active} />
      </Suspense>
    </div>
  );
}
