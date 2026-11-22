"use client";

import { useState } from "react";
import { AI_FIELDS, SUMMARY_GROUPS, VIDEO_FIELDS } from "@/lib/meta-labels";

type Scalar = string | number | null;
export interface Meta {
  summary: Record<string, Record<string, Scalar>>;
  ai: (Record<string, unknown> & { params: Record<string, string>; prompt: string | null; negativePrompt: string | null }) | null;
  video: Record<string, Scalar> | null;
  text: Record<string, string>;
  raw: Record<string, Record<string, string>>;
}

const NA = <span className="muted">N/A</span>;

function Row({ label, value }: { label: string; value: Scalar | undefined }) {
  const has = value !== null && value !== undefined && value !== "";
  return (
    <div className="flex gap-3 border-b border-line/40 py-1 text-[13px] last:border-0">
      <dt className="muted w-28 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{has ? String(value) : NA}</dd>
    </div>
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

export default function MetaPanel({ meta, kind }: { meta: Meta | null; kind: string }) {
  if (!meta) {
    return <p className="muted text-sm">元数据尚未生成(文件处理中或处理失败)。</p>;
  }
  const mapsLink = (() => {
    const lat = meta.summary.gps?.latitude;
    const lon = meta.summary.gps?.longitude;
    return typeof lat === "number" && typeof lon === "number" ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}` : null;
  })();

  return (
    <div className="space-y-4">
      {SUMMARY_GROUPS.map((g) => (
        <section key={g.key}>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--accent)" }}>
            {g.title}
            {g.key === "gps" && mapsLink && (
              <a href={mapsLink} target="_blank" rel="noreferrer" className="ml-2 normal-case underline">地图 ↗</a>
            )}
          </h4>
          <dl>
            {g.fields.map(([k, label]) => (
              <Row key={k} label={label} value={meta.summary[g.key]?.[k]} />
            ))}
          </dl>
        </section>
      ))}

      {kind === "video" && (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--accent)" }}>视频流</h4>
          <dl>
            {VIDEO_FIELDS.map(([k, label]) => (
              <Row key={k} label={label} value={meta.video?.[k]} />
            ))}
          </dl>
          {!meta.video && <p className="muted mt-1 text-xs">未检测到 ffprobe,无法读取视频流信息(可通过 FFPROBE_PATH 配置)。</p>}
        </section>
      )}

      <section>
        <h4 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--accent)" }}>
          AI 生成信息 {meta.ai && <span className="chip normal-case">{String(meta.ai.tool)}</span>}
        </h4>
        {meta.ai ? (
          <div className="space-y-2">
            {([["prompt", "提示词"], ["negativePrompt", "负面提示词"]] as const).map(([k, label]) => (
              <div key={k}>
                <div className="muted mb-0.5 flex items-center gap-2 text-[12px]">
                  {label} {meta.ai?.[k] && <Copy text={String(meta.ai[k])} />}
                </div>
                <pre className="glass max-h-40 overflow-auto whitespace-pre-wrap rounded-lg p-2 text-[12px]">{meta.ai?.[k] ? String(meta.ai[k]) : "N/A"}</pre>
              </div>
            ))}
            <dl>
              {AI_FIELDS.map(([k, label]) => (
                <Row key={k} label={label} value={meta.ai?.[k] as Scalar} />
              ))}
              {Object.entries(meta.ai.params).map(([k, v]) => (
                <Row key={k} label={k} value={v} />
              ))}
            </dl>
          </div>
        ) : (
          <p className="text-[13px]">{NA}(未检测到 Stable Diffusion / NovelAI / ComfyUI 等生成参数)</p>
        )}
      </section>

      <section>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--accent)" }}>原始元数据</h4>
        {Object.keys(meta.text).length === 0 && Object.keys(meta.raw).length === 0 && <p className="text-[13px]">{NA}</p>}
        {Object.keys(meta.text).length > 0 && (
          <details className="glass mb-1.5 rounded-lg px-3 py-1.5">
            <summary className="cursor-pointer text-[13px]">PNG 文本块 ({Object.keys(meta.text).length})</summary>
            <dl className="mt-1">
              {Object.entries(meta.text).map(([k, v]) => (
                <div key={k} className="border-b border-line/40 py-1 text-[12px] last:border-0">
                  <dt className="muted">{k}</dt>
                  <dd className="max-h-32 overflow-auto whitespace-pre-wrap break-all">{v.length > 3000 ? `${v.slice(0, 3000)}…` : v}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        {Object.entries(meta.raw).map(([sec, fields]) => (
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
    </div>
  );
}
