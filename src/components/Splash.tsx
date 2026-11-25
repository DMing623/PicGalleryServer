"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useCallback, useEffect, useRef, useState } from "react";

interface SplashConf {
  enabled: boolean;
  mode: "builtin" | "url";
  url: string;
  durationMs: number;
  title: string;
}

/** 启动页:内置模式 = 粒子网络 + 3D 旋转光环 + 3D 挤出文字;url 模式 = https 图片/视频/网页。每个标签页会话只显示一次。 */
export default function Splash({ conf }: { conf: SplashConf }) {
  const [visible, setVisible] = useState(conf.enabled);
  const [leaving, setLeaving] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const close = useCallback(() => {
    setLeaving(true);
    try {
      sessionStorage.setItem("pgs-splash", "1");
    } catch {
      /* 隐私模式 */
    }
    setTimeout(() => setVisible(false), 650);
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
    return () => clearTimeout(t);
  }, [conf.enabled, conf.durationMs, close]);

  // 启动页消失后通知其它组件(免责声明弹窗在此之后出现)
  useEffect(() => {
    if (visible) return;
    (window as unknown as { __pgsSplashDone?: boolean }).__pgsSplashDone = true;
    window.dispatchEvent(new Event("pgs:splash-done"));
  }, [visible]);

  // 粒子网络:批量路径绘制(每帧仅 1 次 fill + 3 次分档 stroke),并在离场阶段立即停帧释放主线程
  useEffect(() => {
    if (!visible || leaving || conf.mode !== "builtin") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#d97757";
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const mouse = { x: -999, y: -999 };
    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const count = Math.min(120, Math.floor((w * h) / 12000));
    const ps = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.7,
      vy: (Math.random() - 0.5) * 0.7,
      r: Math.random() * 1.8 + 0.6,
    }));

    const b0: number[] = [];
    const b1: number[] = [];
    const b2: number[] = [];
    let raf = 0;

    const tick = () => {
      if (document.visibilityState === "hidden") {
        raf = requestAnimationFrame(tick);
        return;
      }
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const dx = mouse.x - p.x;
        const dy = mouse.y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 22000) {
          p.vx += (dx / 1200) * 0.35;
          p.vy += (dy / 1200) * 0.35;
        }
        p.vx *= 0.995;
        p.vy *= 0.995;
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
        ctx.moveTo(p.x + p.r, p.y);
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      }
      ctx.fill();

      b0.length = 0;
      b1.length = 0;
      b2.length = 0;
      for (let i = 0; i < ps.length; i++) {
        const pi = ps[i];
        for (let j = i + 1; j < ps.length; j++) {
          const pj = ps[j];
          const dx = pi.x - pj.x;
          if (dx > 110 || dx < -110) continue;
          const dy = pi.y - pj.y;
          if (dy > 110 || dy < -110) continue;
          const d = dx * dx + dy * dy;
          if (d < 4000) b0.push(pi.x, pi.y, pj.x, pj.y);
          else if (d < 8000) b1.push(pi.x, pi.y, pj.x, pj.y);
          else if (d < 12000) b2.push(pi.x, pi.y, pj.x, pj.y);
        }
      }

      ctx.strokeStyle = accent;
      ctx.lineWidth = 0.8;
      const buckets: Array<[number[], number]> = [
        [b0, 0.28],
        [b1, 0.17],
        [b2, 0.08],
      ];
      for (const [arr, alpha] of buckets) {
        if (!arr.length) continue;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (let k = 0; k < arr.length; k += 4) {
          ctx.moveTo(arr[k], arr[k + 1]);
          ctx.lineTo(arr[k + 2], arr[k + 3]);
        }
        ctx.stroke();
      }

      raf = requestAnimationFrame(tick);
    };
    tick();
    const move = (e: PointerEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };
    window.addEventListener("resize", resize, { passive: true });
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", move);
    };
  }, [visible, leaving, conf.mode]);

  if (!visible) return null;

  const isImg = /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(conf.url);
  const isVideo = /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(conf.url);
  const title = conf.title || "PicGalleryServer";
  const LAYERS = 12;

  return (
    <div
      className="fixed inset-0 z-[100] overflow-hidden splash-root"
      style={{
        background: "radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--bg2) 90%, #000) 0%, color-mix(in srgb, var(--bg) 40%, #000) 100%)",
        opacity: leaving ? 0 : 1,
        transform: leaving ? "scale(1.04) translateZ(0)" : "translateZ(0)",
        pointerEvents: leaving ? "none" : "auto",
        willChange: "opacity, transform",
        transition: "opacity .55s cubic-bezier(0.22, 1, 0.36, 1), transform .55s cubic-bezier(0.22, 1, 0.36, 1)",
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
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
          <div className="absolute inset-0 flex items-center justify-center" style={{ perspective: "1000px" }}>
            <div className="relative" style={{ width: "min(70vw, 460px)", aspectRatio: "1", transformStyle: "preserve-3d" }}>
              <div className="ring ring-a" />
              <div className="ring ring-b" />
              <div className="ring ring-c" />
            </div>
            <div className="absolute title3d" style={{ perspective: "900px" }}>
              <div className="relative font-black tracking-wider" style={{ fontSize: "clamp(2rem, 7vw, 4.6rem)", transformStyle: "preserve-3d", height: "1.2em", width: "max-content" }}>
                {Array.from({ length: LAYERS }).map((_, i) => (
                  <span
                    key={i}
                    className="layer"
                    style={{
                      transform: `translateZ(${-(i + 1) * 3}px)`,
                      color: `color-mix(in srgb, var(--accent) ${Math.max(18, 70 - i * 5)}%, #000)`,
                    }}
                    aria-hidden
                  >
                    {title}
                  </span>
                ))}
                <span
                  className="relative"
                  style={{
                    backgroundImage: "linear-gradient(120deg, #fff, var(--accent) 55%, #fff)",
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    color: "transparent",
                    textShadow: "0 0 30px color-mix(in srgb, var(--accent) 60%, transparent)",
                  }}
                >
                  {title}
                </span>
              </div>
            </div>
          </div>
          <div className="absolute bottom-[14%] left-1/2 h-[3px] w-56 -translate-x-1/2 overflow-hidden rounded-full" style={{ background: "color-mix(in srgb, var(--accent) 20%, transparent)" }}>
            <div className="h-full origin-left rounded-full" style={{ background: "var(--accent)", animation: `splash-progress ${conf.durationMs}ms ease-out forwards` }} />
          </div>
        </>
      )}
      <button onClick={close} className="btn glass absolute right-5 top-5 text-xs" style={{ color: "var(--fg)" }}>
        跳过 ›
      </button>
    </div>
  );
}
