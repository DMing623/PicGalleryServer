// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { authenticate } from "@/server/auth";
import { serveMedia } from "@/server/files";
import { fail } from "@/server/http";
import { ensureReady } from "@/server/ready";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 公开文件链接 /f/<id>[.ext][?key=<下载密钥>][&dl=1]
 * 无密钥 → 预览图(视频为封面);有效密钥 → 原文件。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureReady();
    const { id } = await ctx.params;
    const user = await authenticate(req);
    return await serveMedia(req, id.replace(/\.[A-Za-z0-9]{1,5}$/, ""), "file", user);
  } catch (e) {
    return fail(e);
  }
}
