// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/** 汇总注册所有 /api/v1 路由模块(导入即注册)。 */
import "./auth";
import "./albums";
import "./media";
import "./hd";
import "./admin";
import "./blocklist";
import "./notices";

export { dispatch } from "../router";
