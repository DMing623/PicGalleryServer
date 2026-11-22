/** 汇总注册所有 /api/v1 路由模块(导入即注册)。 */
import "./auth";
import "./albums";
import "./media";
import "./admin";

export { dispatch } from "../router";
