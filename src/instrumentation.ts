// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureReady } = await import("./server/ready");
    // 启动即初始化(建表、同步管理员、恢复队列);失败时由首个请求重试
    ensureReady().catch(() => undefined);
  }
}
