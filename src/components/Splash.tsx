"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

export interface SplashConf {
  enabled: boolean;
  mode: "builtin" | "url";
  url: string;
  durationMs: number;
  title: string;
  subtitle?: string;
}

/** 将主题色解析为 RGB 元组,便于 Canvas 高帧率绘制多层次半透明光效 */
function parseColorRgb(raw: string): [number, number, number] {
  const s = raw.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [217, 119, 87];
}

/** 计算可替换标题的视觉宽度权重(兼顾中日韩宽字符、拉丁字母与长短句自适应字号) */
function calcVisualUnits(chars: string[]): number {
  let units = 0;
  for (const ch of chars) {
    if (/[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/.test(ch)) units += 1.65;
    else if (/\s/.test(ch)) units += 0.45;
    else if (/[A-Z0-9@%&WM]/.test(ch)) units += 1.08;
    else units += 0.9;
  }
  return Math.max(2, units);
}

/**
 * 启动页(重构版):
 * - 内置模式 = 深空极光星云 + 3D 景深星轨粒子网络 + 精密光学星盘刻线 + 变形宽银幕眩光 + 多轴 3D 陀螺星环 + 可替换逐字流光 3D 立体标题与镜像倒影
 * - url 模式 = https 图片 / 视频 / 网页
 * - 每个标签页会话只显示一次,支持点击「跳过」或按 Esc / Space 立即进入画廊。
 */
export default function Splash({ conf }: { conf: SplashConf }) {
  const [visible, setVisible] = useState(conf.enabled);
  const [leaving, setLeaving] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);

  const close = useCallback(() => {
    setLeaving((prev) => {
      if (prev) return prev;
      try {
        sessionStorage.setItem("pgs-splash", "1");
      } catch {
        /* 隐私模式 */
      }
      setTimeout(() => setVisible(false), 650);
      return true;
    });
  }, []);

  useEffect(() => {
    if (!conf.enabled) return;
    let seen = false;
    try {
      seen = sessionStorage.getItem("pgs-splash") === "1";
    } catch {
      /* ignore */
    }
    if (seen) {
      setVisible(false);
      return;
    }
    const t = setTimeout(close, conf.durationMs);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [conf.enabled, conf.durationMs, close]);

  // 启动页消失后通知其它组件(免责声明弹窗在此之后出现)
  useEffect(() => {
    if (visible) return;
    (window as unknown as { __pgsSplashDone?: boolean }).__pgsSplashDone = true;
    window.dispatchEvent(new Event("pgs:splash-done"));
  }, [visible]);

  // 粒子星轨 + 光学星盘 + 实时 3D 视差 + 进度读数:离场阶段立即停帧释放主线程
  useEffect(() => {
    if (!visible || leaving || conf.mode !== "builtin") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const accentRaw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#d97757";
    const [ar, ag, ab] = parseColorRgb(accentRaw);
    // 互补冷暖辅色,营造电影级双色星云层次
    const [br, bg, bb] = [
      Math.min(255, Math.round(ar * 0.45 + 95)),
      Math.min(255, Math.round(ag * 0.65 + 110)),
      Math.min(255, Math.round(ab * 0.85 + 145)),
    ];

    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const mouse = { x: -9999, y: -9999, tx: 0, ty: 0, cx: 0, cy: 0, active: false };

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const count = Math.min(130, Math.max(60, Math.floor((w * h) / 10500)));
    const ps = Array.from({ length: count }, (_, idx) => {
      const angle = (idx / count) * Math.PI * 2 + Math.random() * 0.5;
      const dist = Math.random() * Math.max(w, h) * 0.55;
      return {
        x: w * 0.5 + Math.cos(angle) * dist,
        y: h * 0.5 + Math.sin(angle) * dist,
        z: Math.random() * 0.85 + 0.15, // 景深权重 0.15 ~ 1.0
        vx: (Math.random() - 0.5) * 0.85,
        vy: (Math.random() - 0.5) * 0.85,
        r: Math.random() * 1.9 + 0.55,
        phase: Math.random() * Math.PI * 2,
      };
    });

    // 点击/划过激起的光波涟漪
    const ripples: Array<{ x: number; y: number; r: number; maxR: number; alpha: number }> = [];

    const b0: number[] = [];
    const b1: number[] = [];
    const b2: number[] = [];
    const bCore: number[] = [];
    const startAt = performance.now();
    const dur = Math.max(800, conf.durationMs);
    let raf = 0;

    const tick = (now: number) => {
      if (document.visibilityState === "hidden") {
        raf = requestAnimationFrame(tick);
        return;
      }
      const elapsed = now - startAt;
      const t = elapsed * 0.001;
      const progress = Math.min(1, elapsed / dur);

      // 更新底部百分比数字(直接写 DOM,零 React 重渲染)
      if (pctRef.current) {
        const pct = Math.min(100, Math.round(progress * 100));
        pctRef.current.textContent = `${String(pct).padStart(2, "0")}%`;
      }

      // 平滑阻尼追踪鼠标/陀螺视差,驱动 3D 舞台倾斜
      const targetX = mouse.active ? (mouse.x / Math.max(1, w) - 0.5) * 2 : Math.sin(t * 0.9) * 0.28;
      const targetY = mouse.active ? (mouse.y / Math.max(1, h) - 0.5) * 2 : Math.cos(t * 0.7) * 0.22;
      mouse.cx += (targetX - mouse.cx) * 0.075;
      mouse.cy += (targetY - mouse.cy) * 0.075;

      if (stageRef.current) {
        stageRef.current.style.setProperty("--splash-rx", `${(-mouse.cy * 11).toFixed(2)}deg`);
        stageRef.current.style.setProperty("--splash-ry", `${(mouse.cx * 14).toFixed(2)}deg`);
        stageRef.current.style.setProperty("--splash-px", `${(mouse.cx * 18).toFixed(1)}px`);
        stageRef.current.style.setProperty("--splash-py", `${(mouse.cy * 14).toFixed(1)}px`);
      }

      ctx.clearRect(0, 0, w, h);
      const cx = w * 0.5 + mouse.cx * 22;
      const cy = h * 0.48 + mouse.cy * 18;
      const baseR = Math.min(w, h) * 0.34;

      // 1. 深空体积极光晕(双核心呼吸光场)
      const g1 = ctx.createRadialGradient(
        cx + Math.cos(t * 0.6) * baseR * 0.25,
        cy + Math.sin(t * 0.5) * baseR * 0.2,
        0,
        cx,
        cy,
        baseR * 1.65,
      );
      g1.addColorStop(0, `rgba(${ar},${ag},${ab},0.22)`);
      g1.addColorStop(0.45, `rgba(${br},${bg},${bb},0.08)`);
      g1.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g1;
      ctx.fillRect(0, 0, w, h);

      // 2. 光学星盘刻度与黄金分割脉冲弧线
      ctx.save();
      ctx.translate(cx, cy);
      const dialR = Math.min(w, h) * 0.29;
      ctx.strokeStyle = `rgba(${ar},${ag},${ab},0.24)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const ticks = 60;
      for (let i = 0; i < ticks; i++) {
        const a = (i / ticks) * Math.PI * 2 + t * 0.08;
        const longTick = i % 5 === 0;
        const rIn = dialR * (longTick ? 0.94 : 0.97);
        const rOut = dialR * (longTick ? 1.02 : 1.0);
        ctx.moveTo(Math.cos(a) * rIn, Math.sin(a) * rIn);
        ctx.lineTo(Math.cos(a) * rOut, Math.sin(a) * rOut);
      }
      ctx.stroke();

      // 旋转能量弧
      for (let k = 0; k < 3; k++) {
        const arcR = dialR * (0.76 + k * 0.16);
        const startA = t * (k % 2 === 0 ? 0.55 : -0.42) + k * 2.1;
        ctx.beginPath();
        ctx.strokeStyle = k === 1 ? `rgba(255,255,255,0.22)` : `rgba(${ar},${ag},${ab},${0.32 - k * 0.07})`;
        ctx.lineWidth = k === 0 ? 1.6 : 1;
        ctx.arc(0, 0, arcR, startA, startA + Math.PI * (0.42 - k * 0.08));
        ctx.stroke();
      }
      ctx.restore();

      // 3. 变形宽银幕水平光学眩光(Anamorphic Lens Streak)
      const flareAlpha = 0.22 + Math.sin(t * 2.2) * 0.06;
      const flareGrad = ctx.createLinearGradient(cx - w * 0.46, cy, cx + w * 0.46, cy);
      flareGrad.addColorStop(0, "rgba(0,0,0,0)");
      flareGrad.addColorStop(0.35, `rgba(${ar},${ag},${ab},${flareAlpha * 0.45})`);
      flareGrad.addColorStop(0.5, `rgba(255,255,255,${flareAlpha * 0.95})`);
      flareGrad.addColorStop(0.65, `rgba(${ar},${ag},${ab},${flareAlpha * 0.45})`);
      flareGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = flareGrad;
      ctx.fillRect(cx - w * 0.46, cy - 1.2, w * 0.92, 2.4);

      // 4. 粒子运动 + 鼠标引力漩涡 + 批量路径绘制(每帧仅 2 次 fill + 4 次分档 stroke)
      ctx.fillStyle = accentRaw;
      ctx.globalAlpha = 0.88;
      ctx.beginPath();
      const corePath = new Path2D();

      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        // 微弱环绕涡流 + 鼠标吸引
        const cdx = cx - p.x;
        const cdy = cy - p.y;
        const cd = Math.hypot(cdx, cdy) || 1;
        p.vx += (-cdy / cd) * 0.0035 * p.z;
        p.vy += (cdx / cd) * 0.0035 * p.z;

        if (mouse.active) {
          const dx = mouse.x - p.x;
          const dy = mouse.y - p.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 28000) {
            p.vx += (dx / 1100) * 0.42 * p.z;
            p.vy += (dy / 1100) * 0.42 * p.z;
          }
        }

        p.vx *= 0.992;
        p.vy *= 0.992;
        p.x += p.vx * (0.65 + p.z * 0.7);
        p.y += p.vy * (0.65 + p.z * 0.7);

        if (p.x < -20) p.x = w + 20;
        else if (p.x > w + 20) p.x = -20;
        if (p.y < -20) p.y = h + 20;
        else if (p.y > h + 20) p.y = -20;

        const pr = p.r * (0.65 + p.z * 0.6) * (0.88 + Math.sin(t * 2.4 + p.phase) * 0.16);
        ctx.moveTo(p.x + pr, p.y);
        ctx.arc(p.x, p.y, pr, 0, Math.PI * 2);

        if (p.z > 0.72) {
          corePath.moveTo(p.x + pr * 0.55, p.y);
          corePath.arc(p.x, p.y, pr * 0.55, 0, Math.PI * 2);
        }
      }
      ctx.fill();

      // 高景深粒子高亮白芯
      ctx.fillStyle = "#ffffff";
      ctx.globalAlpha = 0.75;
      ctx.fill(corePath);

      // 5. 星座连线分档批量绘制
      bCore.length = 0;
      b0.length = 0;
      b1.length = 0;
      b2.length = 0;
      for (let i = 0; i < ps.length; i++) {
        const pi = ps[i];
        for (let j = i + 1; j < ps.length; j++) {
          const pj = ps[j];
          const dx = pi.x - pj.x;
          if (dx > 125 || dx < -125) continue;
          const dy = pi.y - pj.y;
          if (dy > 125 || dy < -125) continue;
          const d = dx * dx + dy * dy;
          if (d < 2200) bCore.push(pi.x, pi.y, pj.x, pj.y);
          else if (d < 5200) b0.push(pi.x, pi.y, pj.x, pj.y);
          else if (d < 9800) b1.push(pi.x, pi.y, pj.x, pj.y);
          else if (d < 15000) b2.push(pi.x, pi.y, pj.x, pj.y);
        }
      }

      const buckets: Array<[number[], number, string, number]> = [
        [bCore, 0.46, "#ffffff", 1.15],
        [b0, 0.32, accentRaw, 0.95],
        [b1, 0.18, accentRaw, 0.8],
        [b2, 0.08, accentRaw, 0.65],
      ];
      for (const [arr, alpha, stroke, lw] of buckets) {
        if (!arr.length) continue;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lw;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (let k = 0; k < arr.length; k += 4) {
          ctx.moveTo(arr[k], arr[k + 1]);
          ctx.lineTo(arr[k + 2], arr[k + 3]);
        }
        ctx.stroke();
      }

      // 6. 交互光波涟漪
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i];
        rp.r += 3.2;
        rp.alpha *= 0.95;
        if (rp.alpha < 0.02 || rp.r > rp.maxR) {
          ripples.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.strokeStyle = accentRaw;
        ctx.globalAlpha = rp.alpha;
        ctx.lineWidth = 1.2;
        ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    const move = (e: PointerEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.active = true;
    };
    const down = (e: PointerEvent) => {
      if (ripples.length < 6) {
        ripples.push({ x: e.clientX, y: e.clientY, r: 8, maxR: 180, alpha: 0.55 });
      }
    };
    window.addEventListener("resize", resize, { passive: true });
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", down, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down);
    };
  }, [visible, leaving, conf.mode, conf.durationMs]);

  // 针对可替换文字(任意中英文/符号/长短句)自适应字号、字距与逐字动效参数
  const rawTitle = (conf.title || "PicGalleryServer").trim() || "PicGalleryServer";
  const subtitle = conf.subtitle !== undefined ? conf.subtitle.trim() : "LIGHT & MEMORY · 视觉典藏画廊";
  const chars = useMemo(() => Array.from(rawTitle), [rawTitle]);
  const visualUnits = useMemo(() => calcVisualUnits(chars), [chars]);

  if (!visible) return null;

  const isImg = /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(conf.url);
  const isVideo = /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(conf.url);
  const LAYERS = 12;

  // 根据视觉宽度自动缩放字号,确保 2 字短词或 40 字长句都震撼居中且绝不溢出
  const scale = Math.min(1.22, Math.max(0.36, 13.8 / Math.max(4.2, visualUnits)));
  const minRem = (1.35 * scale).toFixed(2);
  const vwVal = (6.6 * scale).toFixed(2);
  const maxRem = (4.8 * scale).toFixed(2);
  const trackingEm = visualUnits <= 7 ? "0.16em" : visualUnits <= 14 ? "0.08em" : "0.03em";

  return (
    <div
      className="fixed inset-0 z-[100] overflow-hidden select-none splash-root"
      style={{
        background:
          "radial-gradient(circle at 50% 44%, color-mix(in srgb, var(--accent) 16%, #0b0b10) 0%, color-mix(in srgb, var(--bg2) 28%, #050508) 52%, #020204 100%)",
        opacity: leaving ? 0 : 1,
        transform: leaving ? "scale(1.12) translateZ(0)" : "scale(1) translateZ(0)",
        filter: leaving ? "blur(12px)" : "none",
        pointerEvents: leaving ? "none" : "auto",
        willChange: "opacity, transform, filter",
        transition:
          "opacity .62s cubic-bezier(0.16, 1, 0.3, 1), transform .62s cubic-bezier(0.16, 1, 0.3, 1), filter .62s cubic-bezier(0.16, 1, 0.3, 1)",
        // 纯 CSS 兜底:即使客户端脚本没跑起来(加载失败/被拦截),启动页也会在
        // durationMs + 1.2s 后自动淡出,不会把整站永久挡住。
        animation: `splash-auto-hide 1ms linear ${conf.durationMs + 1200}ms forwards`,
      }}
    >
      {conf.mode === "url" ? (
        isImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={conf.url} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
        ) : isVideo ? (
          <video src={conf.url} className="h-full w-full object-cover" autoPlay muted playsInline loop />
        ) : (
          <iframe src={conf.url} title="splash" className="h-full w-full border-0" sandbox="allow-scripts" referrerPolicy="no-referrer" />
        )
      ) : (
        <>
          {/* 暗角与微米级光学网格纹理 */}
          <div className="splash-grid-overlay pointer-events-none absolute inset-0" />
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

          {/* 3D 陀螺星环 + 可替换流光立体文字主舞台 */}
          <div
            ref={stageRef}
            className="absolute inset-0 flex flex-col items-center justify-center px-4"
            style={
              {
                perspective: "1200px",
                "--splash-rx": "0deg",
                "--splash-ry": "0deg",
                "--splash-px": "0px",
                "--splash-py": "0px",
              } as CSSProperties
            }
          >
            {/* 多轴 3D 光学星环阵列 */}
            <div
              className="pointer-events-none absolute flex items-center justify-center"
              style={{
                width: "min(76vw, 520px)",
                aspectRatio: "1",
                transformStyle: "preserve-3d",
                transform: "translate3d(var(--splash-px), var(--splash-py), 0) rotateX(var(--splash-rx)) rotateY(var(--splash-ry))",
                transition: "transform 80ms linear",
              }}
            >
              <div className="splash-aura" />
              <div className="ring ring-outer" />
              <div className="ring ring-a" />
              <div className="ring ring-b" />
              <div className="ring ring-c" />
              <div className="ring ring-core" />
            </div>

            {/* 顶部光学铭牌徽章 */}
            <div className="splash-badge relative z-10 mb-5 flex items-center gap-2 rounded-full px-3.5 py-1 text-[11px] font-medium tracking-[0.24em] uppercase">
              <span className="splash-badge-dot" />
              <span>OPTICAL ARCHIVE ENGINE</span>
            </div>

            {/* 核心 3D 可替换主标题(支持任意字数/语种替换:3D 挤出层 + 逐字快门翻转揭示 + 镜面地面倒影) */}
            <div className="title3d relative z-10 flex flex-col items-center" style={{ perspective: "1000px", maxWidth: "94vw" }}>
              <div
                className="splash-title-stage relative font-black leading-tight"
                style={{
                  fontSize: `clamp(${minRem}rem, ${vwVal}vw, ${maxRem}rem)`,
                  letterSpacing: trackingEm,
                  transformStyle: "preserve-3d",
                  paddingInline: "0.25em",
                }}
              >
                {/* 12 层 3D 纵深挤出立体字块(自动同步可替换标题) */}
                {Array.from({ length: LAYERS }).map((_, i) => (
                  <span
                    key={i}
                    className="layer"
                    style={{
                      transform: `translateZ(${-(i + 1) * 2.8}px)`,
                      color: `color-mix(in srgb, var(--accent) ${Math.max(14, 72 - i * 5)}%, #050508)`,
                      opacity: Math.max(0.22, 0.92 - i * 0.06),
                    }}
                    aria-hidden
                  >
                    {rawTitle}
                  </span>
                ))}

                {/* 顶层逐字 3D 快门翻转 + 金属流光扫光面 */}
                <span className="splash-title-front relative inline-flex flex-wrap items-center justify-center" aria-label={rawTitle}>
                  {chars.map((ch, idx) => {
                    const delayMs = chars.length > 1 ? Math.round((idx / (chars.length - 1)) * 380) : 0;
                    return (
                      <span
                        key={`${idx}-${ch}`}
                        className="splash-char"
                        style={
                          {
                            "--char-delay": `${delayMs}ms`,
                          } as CSSProperties
                        }
                      >
                        {ch === " " ? "\u00A0" : ch}
                      </span>
                    );
                  })}
                </span>

                {/* 底部黑曜石镜面地板倒影(自动同步可替换标题) */}
                <span className="splash-reflect pointer-events-none" aria-hidden>
                  {rawTitle}
                </span>
              </div>

              {/* 可替换副标题 / 标语 */}
              {subtitle && (
                <div className="splash-subtitle-wrap mt-6 flex items-center gap-3 px-4 text-center">
                  <span className="splash-sub-line" />
                  <p className="splash-subtitle text-xs font-medium tracking-[0.28em] sm:text-sm">{subtitle}</p>
                  <span className="splash-sub-line" />
                </div>
              )}
            </div>
          </div>

          {/* 底部精密光学进度条与实时百分比读数 */}
          <div className=" absolute bottom-[9%] left-1/2 z-10 flex w-[min(84vw,320px)] -translate-x-1/2 flex-col gap-2">
            <div className="flex items-center justify-between text-[10px] font-mono tracking-[0.22em] uppercase" style={{ color: "rgba(255,255,255,0.62)" }}>
              <span>INITIALIZING GALLERY</span>
              <span ref={pctRef} style={{ color: "var(--accent)" }}>
                00%
              </span>
            </div>
            <div
              className="relative h-[3px] w-full overflow-hidden rounded-full"
              style={{ background: "color-mix(in srgb, var(--accent) 22%, rgba(255,255,255,0.08))" }}
            >
              <div
                className="splash-progress-bar h-full origin-left rounded-full"
                style={{
                  background: "linear-gradient(90deg, color-mix(in srgb, var(--accent) 70%, #fff), var(--accent), #fff)",
                  boxShadow: "0 0 16px var(--accent)",
                  animation: `splash-progress ${conf.durationMs}ms cubic-bezier(0.22, 1, 0.36, 1) forwards`,
                }}
              />
            </div>
          </div>
        </>
      )}

      <button
        onClick={close}
        className="splash-skip-btn glass absolute right-5 top-5 z-20 flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium tracking-wider"
        style={{ color: "#f5f5f7", borderColor: "color-mix(in srgb, var(--accent) 40%, rgba(255,255,255,0.18))" }}
      >
        <span>跳过</span>
        <span className="opacity-65 text-[10px]">ESC ›</span>
      </button>
    </div>
  );
}
