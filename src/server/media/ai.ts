/** AI 生成图参数解析:Stable Diffusion WebUI / NovelAI / ComfyUI / InvokeAI。仅做字符串解析,无 IO。 */

export interface AiMeta {
  tool: string;
  prompt: string | null;
  negativePrompt: string | null;
  model: string | null;
  seed: string | null;
  steps: string | null;
  sampler: string | null;
  cfgScale: string | null;
  size: string | null;
  /** 其余参数键值 */
  params: Record<string, string>;
  /** 原始文本(截断) */
  raw: string;
}

const s = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));

function tryJson(t: string | undefined): Record<string, unknown> | null {
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A1111 风格: "prompt\nNegative prompt: ..\nSteps: 20, Sampler: ..." */
export function parseA1111(text: string): AiMeta | null {
  const lines = text.split(/\r?\n/);
  let stepsIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Steps:\s*\d+/.test(lines[i])) {
      stepsIdx = i;
      break;
    }
  }
  if (stepsIdx < 0) return null;
  const before = lines.slice(0, stepsIdx).join("\n");
  const negAt = before.indexOf("Negative prompt:");
  const prompt = (negAt >= 0 ? before.slice(0, negAt) : before).trim();
  const negative = negAt >= 0 ? before.slice(negAt + "Negative prompt:".length).trim() : null;
  const params: Record<string, string> = {};
  const re = /\s*([\w][\w \-/]*?):\s*("(?:[^"\\]|\\.)*"|[^,]*)(?:,|$)/g;
  const paramLine = lines.slice(stepsIdx).join(" ");
  let m: RegExpExecArray | null;
  while ((m = re.exec(paramLine))) {
    if (m[0].length === 0) break;
    params[m[1].trim()] = m[2].trim().replace(/^"|"$/g, "");
  }
  const take = (k: string) => {
    const v = params[k];
    delete params[k];
    return v ?? null;
  };
  return {
    tool: "Stable Diffusion WebUI",
    prompt: prompt || null,
    negativePrompt: negative || null,
    steps: take("Steps"),
    sampler: take("Sampler"),
    cfgScale: take("CFG scale"),
    seed: take("Seed"),
    size: take("Size"),
    model: take("Model") ?? null,
    params,
    raw: text.slice(0, 8000),
  };
}

function parseNovelAI(text: Record<string, string>): AiMeta | null {
  const comment = tryJson(text["Comment"]);
  const software = text["Software"] ?? "";
  if (!comment && !/novelai/i.test(software)) return null;
  const c = comment ?? {};
  const v4 = c["v4_prompt"] as { caption?: { base_caption?: string } } | undefined;
  const v4n = c["v4_negative_prompt"] as { caption?: { base_caption?: string } } | undefined;
  const used = new Set(["prompt", "uc", "steps", "sampler", "scale", "seed", "width", "height", "v4_prompt", "v4_negative_prompt"]);
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) if (!used.has(k) && v !== null && typeof v !== "object") params[k] = String(v);
  if (text["Source"]) params["Source"] = text["Source"];
  return {
    tool: "NovelAI",
    prompt: s(c["prompt"]) ?? s(v4?.caption?.base_caption) ?? s(text["Description"]),
    negativePrompt: s(c["uc"]) ?? s(v4n?.caption?.base_caption),
    steps: s(c["steps"]),
    sampler: s(c["sampler"]),
    cfgScale: s(c["scale"]),
    seed: s(c["seed"]),
    size: c["width"] && c["height"] ? `${c["width"]}x${c["height"]}` : null,
    model: s(text["Source"]),
    params,
    raw: (text["Comment"] ?? text["Description"] ?? "").slice(0, 8000),
  };
}

type ComfyNode = { class_type?: string; inputs?: Record<string, unknown> };

function parseComfy(promptJson: Record<string, unknown>): AiMeta | null {
  const nodes = promptJson as Record<string, ComfyNode>;
  const entries = Object.values(nodes).filter((n) => n && typeof n === "object" && n.class_type);
  if (!entries.length) return null;
  const sampler = entries.find((n) => /KSampler/i.test(n.class_type ?? ""));
  const textOf = (ref: unknown): string | null => {
    if (!Array.isArray(ref)) return null;
    const n = nodes[String(ref[0])];
    const t = n?.inputs?.["text"];
    return typeof t === "string" ? t : null;
  };
  const ckpt = entries.find((n) => /CheckpointLoader|UNETLoader/i.test(n.class_type ?? ""));
  const latent = entries.find((n) => /EmptyLatentImage/i.test(n.class_type ?? ""));
  const inp = sampler?.inputs ?? {};
  const params: Record<string, string> = {};
  if (inp["scheduler"]) params["Scheduler"] = String(inp["scheduler"]);
  if (inp["denoise"] !== undefined) params["Denoise"] = String(inp["denoise"]);
  const loras = entries.filter((n) => /LoraLoader/i.test(n.class_type ?? "")).map((n) => String(n.inputs?.["lora_name"] ?? ""));
  if (loras.length) params["LoRA"] = loras.join(", ");
  return {
    tool: "ComfyUI",
    prompt: textOf(inp["positive"]),
    negativePrompt: textOf(inp["negative"]),
    steps: s(inp["steps"]),
    sampler: s(inp["sampler_name"]),
    cfgScale: s(inp["cfg"]),
    seed: s(inp["seed"] ?? inp["noise_seed"]),
    size: latent?.inputs?.["width"] ? `${latent.inputs["width"]}x${latent.inputs["height"]}` : null,
    model: s(ckpt?.inputs?.["ckpt_name"] ?? ckpt?.inputs?.["unet_name"]),
    params,
    raw: JSON.stringify(promptJson).slice(0, 8000),
  };
}

function parseInvoke(j: Record<string, unknown>): AiMeta {
  const model = j["model"] as { name?: string } | string | undefined;
  return {
    tool: "InvokeAI",
    prompt: s(j["positive_prompt"]),
    negativePrompt: s(j["negative_prompt"]),
    steps: s(j["steps"]),
    sampler: s(j["scheduler"]),
    cfgScale: s(j["cfg_scale"]),
    seed: s(j["seed"]),
    size: j["width"] ? `${j["width"]}x${j["height"]}` : null,
    model: typeof model === "string" ? model : s(model?.name),
    params: {},
    raw: JSON.stringify(j).slice(0, 8000),
  };
}

/**
 * 综合各来源文本判断是否 AI 生成图。
 * @param pngText PNG 文本块(或隐写解出的键值)
 * @param exifComment EXIF UserComment / ImageDescription 文本(JPEG/WebP 常见)
 */
export function detectAi(pngText: Record<string, string>, exifComment: string | null): AiMeta | null {
  if (pngText["parameters"]) {
    const a = parseA1111(pngText["parameters"]);
    if (a) return a;
  }
  const nai = parseNovelAI(pngText);
  if (nai && (nai.prompt || nai.params["Source"])) return nai;
  const wf = tryJson(pngText["prompt"]);
  if (wf) {
    const c = parseComfy(wf);
    if (c) return c;
  }
  const inv = tryJson(pngText["invokeai_metadata"]);
  if (inv) return parseInvoke(inv);
  if (exifComment) {
    const a = parseA1111(exifComment);
    if (a) return a;
    const j = tryJson(exifComment);
    if (j && (j["prompt"] || j["uc"])) return parseNovelAI({ Comment: exifComment });
  }
  return null;
}
