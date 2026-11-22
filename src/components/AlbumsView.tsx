"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { bytes } from "@/lib/format";
import AlbumActions, { type AlbumDto } from "./AlbumActions";
import { useApp } from "./AppProvider";
import Gallery from "./Gallery";

interface Detail extends AlbumDto {
  breadcrumbs: Array<{ code: string; name: string }>;
  children: AlbumDto[];
}

function Card({ a }: { a: AlbumDto }) {
  const { can } = useApp();
  return (
    <Link href={`/albums/${a.code}`} className="tile glass group block overflow-hidden rounded-2xl">
      <div className="relative aspect-[4/3] w-full overflow-hidden" style={{ background: "linear-gradient(135deg, var(--bg2), color-mix(in srgb, var(--accent) 25%, var(--bg)))" }}>
        {a.coverId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/v1/media/${a.coverId}/thumb`} alt="" loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
        ) : (
          <div className="flex h-full items-center justify-center text-4xl opacity-60">📁</div>
        )}
        {can("album.manage") && (
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
}

export default function AlbumsView({ code }: { code?: string }) {
  const { loading, can, me } = useApp();
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [list, setList] = useState<AlbumDto[] | null>(null);
  const [unsorted, setUnsorted] = useState<number | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      if (code === "_unsorted") return;
      if (code) setDetail(await api<Detail>(`/albums/${code}`));
      else {
        const r = await api<{ albums: AlbumDto[]; unsorted: number | null }>("/albums?parent=root");
        setList(r.albums);
        setUnsorted(r.unsorted);
      }
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [code]);

  useEffect(() => {
    if (loading) return;
    void load();
    const h = () => void load();
    window.addEventListener("pgs:albums", h);
    return () => window.removeEventListener("pgs:albums", h);
  }, [load, loading, me?.user?.id]);

  if (code === "_unsorted") {
    return (
      <div>
        <h1 className="mb-3 text-xl font-semibold">未归类(收件箱)</h1>
        <Suspense fallback={null}><Gallery album="_unsorted" /></Suspense>
      </div>
    );
  }

  if (err) {
    return (
      <div className="glass mx-auto mt-10 max-w-md rounded-3xl p-10 text-center">
        <p className="font-medium">{err}</p>
        <Link href="/albums" className="btn mt-4">返回相册列表</Link>
      </div>
    );
  }

  if (!code) {
    return (
      <div>
        <div className="mb-4 flex items-center gap-3">
          <h1 className="text-xl font-semibold">相册</h1>
          {can("album.manage") && (
            <button
              className="btn btn-primary"
              onClick={async () => {
                const name = prompt("新相册名称");
                if (!name) return;
                try {
                  await api("/albums", { method: "POST", json: { name, visibility: "private" } });
                  await load();
                } catch (e) {
                  alert((e as Error).message);
                }
              }}
            >
              ＋ 新建相册
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {unsorted !== null && (
            <Link href="/albums/_unsorted" className="tile glass flex aspect-[4/3] flex-col items-center justify-center rounded-2xl p-3 text-center">
              <span className="text-3xl">📥</span>
              <span className="mt-1 font-medium">未归类</span>
              <span className="muted text-xs">{unsorted} 项</span>
            </Link>
          )}
          {list?.map((a) => <Card key={a.code} a={a} />)}
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
      <div className="glass mb-4 rounded-2xl p-4">
        <nav className="muted mb-1 flex flex-wrap items-center gap-1 text-sm">
          <Link href="/albums" className="hover:underline">相册</Link>
          {detail.breadcrumbs.map((b) => (
            <span key={b.code}>
              / <Link href={`/albums/${b.code}`} className="hover:underline">{b.name}</Link>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{detail.name}</h1>
          {can("album.manage") && (
            <>
              <span className="chip">{detail.visibility === "public" ? "公开" : "私有"}</span>
              <span className="chip">{detail.kind === "mounted" ? "挂载目录" : detail.storage === "s3" ? "受管 · S3" : "受管 · 本地"}</span>
            </>
          )}
          <span className="muted text-sm">{detail.counts.mediaTotal} 项 · {bytes(detail.counts.sizeTotal)}</span>
          <div className="ml-auto">
            <AlbumActions album={detail} onChanged={load} onDeleted={() => router.push(detail.parent ? `/albums/${detail.parent}` : "/albums")} />
          </div>
        </div>
        {detail.rootPath && <p className="muted mt-1 break-all text-xs">📂 {detail.rootPath}</p>}
        {detail.description && <p className="mt-2 text-sm">{detail.description}</p>}
      </div>

      {detail.children.length > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-7">
          {detail.children.map((a) => <Card key={a.code} a={a} />)}
        </div>
      )}
      <Suspense fallback={null}>
        <Gallery album={code} />
      </Suspense>
    </div>
  );
}
