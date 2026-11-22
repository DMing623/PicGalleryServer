"use client";
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * 内置对话框:取代浏览器原生 alert / confirm / prompt 与原生表单验证气泡。
 *  confirm → Promise<boolean>   prompt → Promise<string | null>   choose → Promise<value | null>   alert → Promise<void>
 * 输入校验错误显示在对话框内部(validate 返回错误文案),而不是浏览器气泡。
 */

export interface ChoiceOption {
  value: string;
  label: string;
  kind?: "primary" | "danger" | "default";
}

interface ChooseOpts {
  title?: string;
  message?: ReactNode;
  options: ChoiceOption[];
  cancelText?: string | null;
}

interface ConfirmOpts {
  title?: string;
  message?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface PromptOpts {
  title: string;
  label?: string;
  message?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  password?: boolean;
  /** 返回错误文案则阻止提交并在对话框内显示 */
  validate?: (value: string) => string | null;
}

interface DialogApi {
  choose: (o: ChooseOpts) => Promise<string | null>;
  confirm: (o: ConfirmOpts | string) => Promise<boolean>;
  prompt: (o: PromptOpts) => Promise<string | null>;
  alert: (message: ReactNode, title?: string) => Promise<void>;
}

type Item =
  | { id: number; kind: "choose"; o: ChooseOpts; resolve: (v: string | null) => void }
  | { id: number; kind: "prompt"; o: PromptOpts; resolve: (v: string | null) => void };

const Ctx = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDialog 必须在 DialogProvider 内使用");
  return c;
}

function Modal({ item, onDone }: { item: Item; onDone: () => void }) {
  const [text, setText] = useState(item.kind === "prompt" ? item.o.defaultValue ?? "" : "");
  const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  const finish = useCallback(
    (v: string | null) => {
      item.resolve(v);
      onDone();
    },
    [item, onDone],
  );

  useEffect(() => {
    if (item.kind === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else primaryRef.current?.focus();
  }, [item]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(null);
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [finish]);

  function submit() {
    if (item.kind !== "prompt") return;
    const v = text.trim();
    const msg = item.o.validate ? item.o.validate(v) : v ? null : "请输入内容";
    if (msg) {
      setErr(msg);
      inputRef.current?.focus();
      return;
    }
    finish(v);
  }

  const title = item.o.title;
  const cls = (k?: string) => (k === "primary" ? "btn btn-primary" : k === "danger" ? "btn btn-danger" : "btn");

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && finish(null)}>
      <div role="dialog" aria-modal="true" className="glass-strong fade-in w-full max-w-sm rounded-2xl p-5 shadow-2xl">
        {title && <h3 className="mb-1.5 text-base font-semibold">{title}</h3>}
        {item.kind === "choose" ? (
          <>
            {item.o.message && <div className="mb-4 whitespace-pre-wrap text-sm leading-relaxed">{item.o.message}</div>}
            <div className="flex flex-col gap-2">
              {item.o.options.map((op, i) => (
                <button key={op.value} ref={i === 0 ? primaryRef : undefined} className={`${cls(op.kind)} !justify-center`} onClick={() => finish(op.value)}>
                  {op.label}
                </button>
              ))}
              {item.o.cancelText !== null && (
                <button className="btn !justify-center" onClick={() => finish(null)}>
                  {item.o.cancelText ?? "取消"}
                </button>
              )}
            </div>
          </>
        ) : (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {item.o.message && <div className="mb-2 whitespace-pre-wrap text-sm">{item.o.message}</div>}
            {item.o.label && <label className="muted mb-1 block text-xs">{item.o.label}</label>}
            <input
              ref={inputRef}
              className="field"
              type={item.o.password ? "password" : "text"}
              value={text}
              placeholder={item.o.placeholder}
              autoComplete="off"
              onChange={(e) => {
                setText(e.target.value);
                if (err) setErr("");
              }}
            />
            <p className="mt-1.5 min-h-[1.1rem] text-xs text-red-600">{err}</p>
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => finish(null)}>取消</button>
              <button type="submit" className="btn btn-primary">{item.o.confirmText ?? "确定"}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Item[]>([]);

  const seq = useRef(0);
  const push = useCallback(
    (make: (resolve: (v: string | null) => void) => Omit<Item, "id">) =>
      new Promise<string | null>((resolve) => setQueue((q) => [...q, { ...make(resolve), id: ++seq.current } as Item])),
    [],
  );

  const api = useMemo<DialogApi>(
    () => ({
      choose: (o) => push((resolve) => ({ kind: "choose", o, resolve })),
      confirm: async (o) => {
        const x: ConfirmOpts = typeof o === "string" ? { message: o } : o;
        const v = await push((resolve) => ({
          kind: "choose",
          resolve,
          o: { title: x.title ?? "请确认", message: x.message, options: [{ value: "ok", label: x.confirmText ?? "确定", kind: x.danger ? "danger" : "primary" }], cancelText: x.cancelText ?? "取消" },
        }));
        return v === "ok";
      },
      prompt: (o) => push((resolve) => ({ kind: "prompt", o, resolve })),
      alert: async (message, title) => {
        await push((resolve) => ({ kind: "choose", resolve, o: { title: title ?? "提示", message, options: [{ value: "ok", label: "知道了", kind: "primary" }], cancelText: null } }));
      },
    }),
    [push],
  );

  const cur = queue[0];
  return (
    <Ctx.Provider value={api}>
      {children}
      {cur && <Modal key={cur.id} item={cur} onDone={() => setQueue((q) => q.slice(1))} />}
    </Ctx.Provider>
  );
}
