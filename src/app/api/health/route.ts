// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * 平台/容器健康检查(liveness):只要进程还能响应就返回 200。
 * 不查数据库 —— 数据库短暂抖动不应让容器被判死重启(issue §3.1)。
 * 需要"数据库连通 + 数据目录可写"的 readiness 检查请用 /api/v1/health/ready。
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true, status: "ok" });
}
