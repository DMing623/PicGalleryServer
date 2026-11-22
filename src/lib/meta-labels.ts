// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/** 元数据展示标签。summary 中的每个字段都会显示,缺失则为 N/A。 */
export const SUMMARY_GROUPS: Array<{ key: string; title: string; fields: Array<[string, string]> }> = [
  { key: "file", title: "文件", fields: [
    ["format", "格式"], ["width", "宽度 px"], ["height", "高度 px"], ["megapixels", "百万像素"], ["colorSpace", "色彩空间"],
    ["iccProfile", "ICC 配置"], ["bitDepth", "位深"], ["hasAlpha", "透明通道"], ["density", "分辨率"], ["orientation", "方向"],
  ] },
  { key: "camera", title: "相机 / 设备", fields: [
    ["make", "品牌"], ["model", "型号"], ["lens", "镜头"], ["lensMake", "镜头品牌"], ["software", "软件"], ["serial", "序列号"],
  ] },
  { key: "exposure", title: "拍摄参数", fields: [
    ["exposureTime", "快门"], ["fNumber", "光圈"], ["iso", "ISO"], ["focalLength", "焦距"], ["focalLength35", "等效焦距(35mm)"],
    ["exposureProgram", "曝光程序"], ["exposureBias", "曝光补偿"], ["meteringMode", "测光模式"], ["flash", "闪光灯"],
    ["whiteBalance", "白平衡"], ["sceneType", "场景类型"],
  ] },
  { key: "time", title: "时间", fields: [["taken", "拍摄时间"], ["created", "创建时间"], ["modified", "修改时间"], ["timezone", "时区偏移"]] },
  { key: "gps", title: "位置 (GPS)", fields: [["latitude", "纬度"], ["longitude", "经度"], ["altitude", "海拔"], ["direction", "朝向"]] },
  { key: "authoring", title: "作者 / 版权 / 标注", fields: [
    ["title", "标题"], ["description", "描述"], ["artist", "作者"], ["copyright", "版权"], ["keywords", "关键词"], ["rating", "评分"], ["userComment", "用户注释"],
  ] },
];

export const VIDEO_FIELDS: Array<[string, string]> = [
  ["container", "容器"], ["duration", "时长"], ["resolution", "分辨率"], ["videoCodec", "视频编码"], ["frameRate", "帧率"],
  ["pixelFormat", "像素格式"], ["videoBitrate", "视频码率"], ["totalBitrate", "总码率"], ["audioCodec", "音频编码"],
  ["audioChannels", "声道数"], ["sampleRate", "采样率"], ["createdAt", "创建时间"], ["title", "标题"], ["encoder", "编码器"],
  ["make", "设备品牌"], ["model", "设备型号"], ["software", "软件"], ["latitude", "纬度"], ["longitude", "经度"],
];

export const AI_FIELDS: Array<[string, string]> = [
  ["tool", "生成工具"], ["model", "模型"], ["sampler", "采样器"], ["steps", "步数"], ["cfgScale", "CFG"], ["seed", "种子"], ["size", "尺寸"],
];
