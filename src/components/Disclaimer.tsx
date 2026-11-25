"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useCallback, useEffect, useRef, useState } from "react";

/** 与 layout.tsx 头部内联脚本共用的存储键(脚本在首屏前判断是否已同意,避免已同意用户闪现弹窗) */
export const DISCLAIMER_KEY = "pgs-disclaimer";
/** 修改声明内容时提升版本号,所有访客需重新阅读 */
export const DISCLAIMER_VERSION = 1;
const VALID_DAYS = 30;
const MIN_READ_SEC = 6;

export const DISCLAIMER_BOOT_SCRIPT = `try{var d=JSON.parse(localStorage.getItem(${JSON.stringify(DISCLAIMER_KEY)})||"null");if(d&&d.v===${DISCLAIMER_VERSION}&&Date.now()-d.t<${VALID_DAYS * 86400000}){document.documentElement.setAttribute("data-disc","ok")}}catch(e){}`;

const SECTIONS: Array<{ title: string; items: string[] }> = [
  {
    title: "一、内容来源",
    items: [
      "本图库中的图片与视频由管理员及成员上传,原始来源可能包括网络媒体、个人拍摄、第三方创作等,本站无法逐一核实其真实来源与版权归属。",
      "图库中的部分内容带有来源水印(含本站域名与项目地址),登录用户查看的高清图还带有动态标识水印,用于溯源与防盗用。",
    ],
  },
  {
    title: "二、内容分级与观看提醒",
    items: [
      "部分相册分类可能包含 NSFW(成人、裸露、暴力、血腥、惊悚等敏感)内容,请谨慎观看。",
      "未满 18 周岁、或所在地区法律禁止浏览此类内容、或对此类内容感到不适的访客,请立即离开本站。",
    ],
  },
  {
    title: "三、游客须知与使用限制",
    items: [
      "如您是误入本站的游客,请立即关闭页面或点击下方「不同意并离开」。",
      "您若选择下载、保存、转载图片或视频,仅限个人学习与欣赏;不得将其用于任何商业用途(包括但不限于销售、广告、付费内容、训练或再分发牟利),也不得用于侵犯他人合法权益、诽谤、骚扰或其他违法违规用途。",
      "请遵守您所在国家或地区的法律法规,并尊重原作者与权利人的合法权益。",
    ],
  },
  {
    title: "四、免责声明",
    items: [
      "因任何人下载、使用、传播本站图片或视频而引发的版权纠纷、肖像权/名誉权纠纷、诉讼、行政处罚或其他任何法律责任,均由使用者自行承担,与本网站及其运营者、管理员、成员无关。",
      "本站内容按「现状」提供,不对其合法性、准确性、完整性及适用性作任何明示或默示的担保。",
      "权利人如认为本站内容侵犯了您的合法权益,请联系管理员,经核实后将及时删除。",
    ],
  },
  {
    title: "五、访问记录",
    items: ["为保障安全,本站会对高清预览等请求进行限流与安全日志记录,异常批量访问(如批量爬取)将被限制访问。"],
  },
];

/** 隐私与使用须知正文(通知面板默认展示,无需再次同意) */
export const DISCLAIMER_SECTIONS: Array<{ title: string; items: string[] }> = SECTIONS;

/** 启动页之后弹出的警告:必须滚动阅读到底并等待倒计时结束,点击「同意」后才会消退,露出被模糊的相册主界面。 */
export default function Disclaimer() {
  const [accepted, setAccepted] = useState(false);
  const [gone, setGone] = useState(false);
  const [ready, setReady] = useState(false);
  const [atBottom, setAtBottom] = useState(false);
  const [progress, setProgress] = useState(0);
  const [left, setLeft] = useState(MIN_READ_SEC);
  const box = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);

  // 已同意(未过期)则不再显示
  useEffect(() => {
    try {
      const d = JSON.parse(localStorage.getItem(DISCLAIMER_KEY) || "null");
      if (d && d.v === DISCLAIMER_VERSION && Date.now() - d.t < VALID_DAYS * 86400000) setGone(true);
    } catch {
      /* 隐私模式:每次都显示 */
    }
  }, []);

  // 等启动页结束后再弹出
  useEffect(() => {
    if ((window as unknown as { __pgsSplashDone?: boolean }).__pgsSplashDone) {
      setReady(true);
      return;
    }
    const h = () => setReady(true);
    window.addEventListener("pgs:splash-done", h);
    return () => window.removeEventListener("pgs:splash-done", h);
  }, []);

  const measure = useCallback(() => {
    rafRef.current = 0;
    const el = box.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const nextPct = max <= 0 ? 100 : Math.min(100, Math.round((el.scrollTop / max) * 100));
    setProgress((prev) => (prev === nextPct ? prev : nextPct));
    if (max <= 8 || el.scrollTop >= max - 8) setAtBottom(true);
  }, []);

  const onScroll = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(measure);
  }, [measure]);

  useEffect(() => {
    if (!ready || gone) return;
    measure();
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("resize", onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [ready, gone, measure, onScroll]);

  useEffect(() => {
    if (!ready || gone) return;
    document.body.style.overflow = "hidden";
    const t = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => {
      clearInterval(t);
      document.body.style.overflow = "";
    };
  }, [ready, gone]);

  if (gone) return null;
  const can = atBottom && left === 0;

  function agree() {
    if (!can) return;
    try {
      localStorage.setItem(DISCLAIMER_KEY, JSON.stringify({ v: DISCLAIMER_VERSION, t: Date.now() }));
    } catch {
      /* ignore */
    }
    document.documentElement.setAttribute("data-disc", "ok");
    setAccepted(true);
    document.body.style.overflow = "";
    setTimeout(() => setGone(true), 450);
  }

  function leave() {
    try {
      window.location.replace("about:blank");
    } catch {
      window.history.back();
    }
  }

  return (
    <div
      id="pgs-disclaimer"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="pgs-disc-title"
      className="fixed inset-0 z-[90] flex items-center justify-center p-3 transition-opacity duration-500"
      style={{
        opacity: accepted ? 0 : 1,
        background: "color-mix(in srgb, var(--bg) 35%, rgba(0,0,0,.35))",
        WebkitBackdropFilter: "blur(26px) saturate(1.3)",
        backdropFilter: "blur(26px) saturate(1.3)",
        pointerEvents: accepted ? "none" : "auto",
      }}
    >
      <div
        className="glass-strong flex max-h-[92dvh] w-full max-w-xl flex-col rounded-2xl shadow-2xl transition duration-500"
        style={{ opacity: ready ? 1 : 0, transform: ready ? "none" : "translateY(16px) scale(.98)" }}
      >
        <div className="px-5 pt-4">
          <h2 id="pgs-disc-title" className="flex items-center gap-2 text-lg font-semibold">
            <span aria-hidden>⚠️</span> 内容警告与使用须知
          </h2>
          <p className="muted mt-0.5 text-xs">请完整阅读以下内容(滚动至底部)后,方可进入图库。</p>
        </div>
        <div ref={box} onScroll={onScroll} className="mx-5 my-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-line/60 bg-black/5 p-3 text-[13px] leading-relaxed" style={{ maxHeight: "56dvh" }}>
          {SECTIONS.map((s) => (
            <section key={s.title} className="mb-3 last:mb-0">
              <h3 className="mb-1 font-semibold" style={{ color: "var(--accent)" }}>{s.title}</h3>
              <ul className="list-disc space-y-1 pl-5">
                {s.items.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </section>
          ))}
          <p className="mt-4 border-t border-line/60 pt-3 text-center text-xs font-medium">—— 以上内容已全部阅读完毕 ——</p>
        </div>
        <div className="px-5 pb-4">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-black/10">
              <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: "var(--accent)" }} />
            </div>
            <span className="muted w-24 text-right">{atBottom ? "✓ 已读完" : `已阅读 ${progress}%`}</span>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button className="btn" onClick={leave}>不同意并离开</button>
            <button className="btn btn-primary" disabled={!can} onClick={agree}>
              {!atBottom ? "请滚动阅读到底部" : left > 0 ? `我已阅读并同意(${left}s)` : "我已阅读并同意,进入图库"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
