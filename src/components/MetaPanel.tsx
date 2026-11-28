"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { memo, useMemo, useState } from "react";
import { AI_FIELDS, SUMMARY_GROUPS, VIDEO_FIELDS } from "@/lib/meta-labels";

type Scalar = string | number | null;
export interface Meta {
  summary: Record<string, Record<string, Scalar>>;
  ai: (Record<string, unknown> & { params: Record<string, string>; prompt: string | null; negativePrompt: string | null }) | null;
  video: Record<string, Scalar> | null;
  text: Record<string, string>;
  raw: Record<string, Record<string, string>>;
}

const has = (v: unknown) => v !== null && v !== undefined && v !== "";
/** 这些字段已在详情页「基本信息」中固定展示,不再在元数据区重复 */
const SHOWN_IN_BASICS = new Set(["file.format", "file.width", "file.height", "file.size"]);
const GROUP_TITLE: Record<string, string> = Object.fromEntries(SUMMARY_GROUPS.map((g) => [g.key, g.title]));
const FIELD_LABEL: Record<string, Record<string, string>> = Object.fromEntries(SUMMARY_GROUPS.map((g) => [g.key, Object.fromEntries(g.fields)]));
const FIELD_ORDER: Record<string, string[]> = Object.fromEntries(SUMMARY_GROUPS.map((g) => [g.key, g.fields.map(([k]) => k)]));

function Row({ label, value }: { label: string; value: Scalar | undefined }) {
  return (
    <div className="flex gap-3 border-b border-line/40 py-1 text-[13px] last:border-0">
      <dt className="muted w-28 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 break-all">{String(value)}</dd>
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--accent)" }}>
      {children}
    </h4>
  );
}

function Copy({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="chip cursor-pointer"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        } catch {
          /* ignore */
        }
      }}
    >
      {ok ? "已复制" : "复制"}
    </button>
  );
}

/**
 * 元数据自动渲染(Memo 化):只展示文件里「实际存在」的字段并自动分组,不预设固定表单、不显示一片 N/A。
 * 必备条目(名称/备注/分辨率/相册/ID/上传时间/格式)由 Viewer 的「基本信息」固定提供。
 */
export default memo(function MetaPanel({ meta, kind }: { meta: Meta | null; kind: string }) {
  const parsed = useMemo(() => {
    if (!meta) return null;
    // 摘要:已知分组按预设顺序,未知分组/字段自动追加
    const groupKeys = [...SUMMARY_GROUPS.map((g) => g.key), ...Object.keys(meta.summary).filter((k) => !GROUP_TITLE[k])];
    const groups = groupKeys
      .map((gk) => {
        const src = meta.summary[gk] ?? {};
        const order = FIELD_ORDER[gk] ?? [];
        const keys = [...order.filter((k) => k in src), ...Object.keys(src).filter((k) => !order.includes(k))];
        const rows = keys
          .filter((k) => has(src[k]) && !SHOWN_IN_BASICS.has(`${gk}.${k}`))
          .map((k) => ({ k, label: FIELD_LABEL[gk]?.[k] ?? k, value: src[k] }));
        return { gk, title: GROUP_TITLE[gk] ?? gk, rows };
      })
      .filter((g) => g.rows.length > 0);

    const lat = meta.summary.gps?.latitude;
    const lon = meta.summary.gps?.longitude;
    const mapsLink =
      typeof lat === "number" && typeof lon === "number"
        ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`
        : null;

    const videoRows =
      kind === "video" && meta.video
        ? VIDEO_FIELDS.filter(([k]) => has(meta.video?.[k])).map(([k, l]) => ({ k, l, v: meta.video?.[k] }))
        : [];
    const ai = meta.ai;
    const aiRows = ai
      ? [
          ...AI_FIELDS.filter(([k]) => has(ai[k])).map(([k, l]) => [l, ai[k] as Scalar] as const),
          ...Object.entries(ai.params ?? {})
            .filter(([, v]) => has(v))
            .map(([k, v]) => [k, v] as const),
        ]
      : [];
    const textEntries = Object.entries(meta.text ?? {}).filter(([, v]) => has(v));
    const rawEntries = Object.entries(meta.raw ?? {}).filter(([, f]) => Object.keys(f).length > 0);
    const nothing = !groups.length && !videoRows.length && !ai && !textEntries.length && !rawEntries.length;

    return { groups, mapsLink, videoRows, ai, aiRows, textEntries, rawEntries, nothing };
  }, [meta, kind]);

  if (!parsed) return <p className="muted text-sm">元数据尚未生成(文件处理中或处理失败)。</p>;

  const { groups, mapsLink, videoRows, ai, aiRows, textEntries, rawEntries, nothing } = parsed;

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.gk}>
          <Title>
            {g.title}
            {g.gk === "gps" && mapsLink && (
              <a href={mapsLink} target="_blank" rel="noreferrer" className="ml-1 normal-case underline">地图 ↗</a>
            )}
          </Title>
          <dl>
            {g.rows.map((r) => (
              <Row key={r.k} label={r.label} value={r.value} />
            ))}
          </dl>
        </section>
      ))}

      {videoRows.length > 0 && (
        <section>
          <Title>视频流</Title>
          <dl>
            {videoRows.map((r) => (
              <Row key={r.k} label={r.l} value={r.v} />
            ))}
          </dl>
        </section>
      )}

      {ai && (
        <section>
          <Title>
            AI 生成信息 <span className="chip normal-case">{String(ai.tool)}</span>
          </Title>
          <div className="space-y-2">
            {([["prompt", "提示词"], ["negativePrompt", "负面提示词"]] as const)
              .filter(([k]) => has(ai[k]))
              .map(([k, label]) => (
                <div key={k}>
                  <div className="muted mb-0.5 flex items-center gap-2 text-[12px]">
                    {label} <Copy text={String(ai[k])} />
                  </div>
                  <pre className="glass max-h-40 overflow-auto whitespace-pre-wrap rounded-lg p-2 text-[12px]">{String(ai[k])}</pre>
                </div>
              ))}
            {aiRows.length > 0 && (
              <dl>
                {aiRows.map(([l, v]) => (
                  <Row key={l} label={l} value={v} />
                ))}
              </dl>
            )}
          </div>
        </section>
      )}

      {(textEntries.length > 0 || rawEntries.length > 0) && (
        <section>
          <Title>原始元数据</Title>
          {textEntries.length > 0 && (
            <details className="glass mb-1.5 rounded-lg px-3 py-1.5">
              <summary className="cursor-pointer text-[13px]">PNG 文本块 ({textEntries.length})</summary>
              <dl className="mt-1">
                {textEntries.map(([k, v]) => (
                  <div key={k} className="border-b border-line/40 py-1 text-[12px] last:border-0">
                    <dt className="muted">{k}</dt>
                    <dd className="max-h-32 overflow-auto whitespace-pre-wrap break-all">{v.length > 3000 ? `${v.slice(0, 3000)}…` : v}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          {rawEntries.map(([sec, fields]) => (
            <details key={sec} className="glass mb-1.5 rounded-lg px-3 py-1.5">
              <summary className="cursor-pointer text-[13px]">{sec} ({Object.keys(fields).length})</summary>
              <dl className="mt-1">
                {Object.entries(fields).map(([k, v]) => (
                  <Row key={k} label={k} value={v.length > 600 ? `${v.slice(0, 600)}…` : v} />
                ))}
              </dl>
            </details>
          ))}
        </section>
      )}

      {nothing && <p className="muted text-[13px]">这个文件没有携带额外的元数据(相机 / AI 生成信息 / 工作流等),因此只显示上面的基本信息。</p>}
    </div>
  );
});
