# 拆分与素材说明

2026-09-20 从既有逆向工具包提取为独立开发项目。本仓库包含编辑器开发和构建所需的源码、PNG、JSON 与字体；原始逆向缓存和游戏脚本文本不参与构建，也不随仓库分发。

拆分后路径均相对于本项目目录。已移除旧彩色渲染器依赖；保留 `dumper_nop_1 → item_port_dumper_1` 的原有有效映射到 `data/building_item_fallbacks.json`。土壤原图的显式回退及缺图原因在 `data/icon_audit.json`。

原版 Sprite 已完成解包，本项目直接读取 PNG。`assets/blueprint_source/index.json` 保留九宫格 border、原始资源路径和对象 ID，`prefab_images.json` 保留 UI 颜色和位置。`assets/blueprint_presentation/` 是封面、顶部装饰和详情相关素材。游戏资源路径是来源信息，不是构建时访问的文件路径。

绘制规则参考 BlueprintPreview、FacConst、FactoryUtils、BlueprintContent、BlueprintIcon、ItemIcon、UIConst、Utils。原始 Lua 文本只在本地 `research/source-evidence/` 归档，Git 忽略该目录；独立构建使用已提取到 `assets/` 的位置、颜色、Sprite 边界和动画曲线等 JSON 元数据，不执行或连接游戏。

中文文本表已从完整游戏文本精简为上述建筑、物品与蓝图标签表引用的 2,559 条名称。精简不改变最终网页中的名称、图标及展示数据。原始资源的名称和对象路径仍作为来源信息保留；它们不是本机绝对路径。

目前包括 112 个建筑表条目、8 类物流节点、864 条物品/环境记录，其中 835 条可绘制。原先缺图的 30 条已核对：1 条找回同名原图，3 条未配置且无同名原图，26 条配置图名在当前安装资源中未找到。详见 `missing-icons.md`。

20 个装饰/土壤/特殊条目缺少原始大号底纹，绘制时保留中央符号并省略底纹。完整预览中的封面、设备图、顶部标志、详情渐变、放大镜纹样与窄边栏均使用原始图片。字体使用原始 HarmonyOS Sans SC 可变字体，内嵌于离线 HTML，预览及导出均等待字体加载完成；网格使用原始图片；空标签轮廓、名称括号和滚动条由 Canvas 绘制，尚不宣称逐像素复现。

2026-09-20 补充从 `facsaveblueprintpanel.prefab` 的 170 个依赖包中恢复外框素材，读取 9,102 个对象，解码失败 0。独立项目仅新增所需的 5 张原图和引用元数据，位于 `assets/preview_frame/`。完整逆向缓存仍位于旧工具包的 `research/preview_frame_20260920/`，运行和构建不访问该目录。

环境生效标记来自 `gas/icon_gas_env_effected_*`，使用原始 EnvIcon 尺寸 290×70，以及 EnvNode 相对中心向上 75.4 的偏移，按每格 128 像素绘制。蓝色对应 `stable`，绿色对应 `xiranite`，黄色对应 `acid`，白色对应 `humidity`，橙色对应 `inactive`。JSON 的 `environmentEffect` 字段是手工标注，不推算覆盖范围。

`closedPorts` 保存 `input:序号` / `output:序号`（原始表的 0 起始索引）。关闭接口后，前端按原版规则重新组合端口、边缘装饰和底纹；中央符号保持正向。仅支持带独立端口层的设备，固定仓库口等一体底图不提供此开关。已有线路保持原样，隐藏端口不再吸附新线路。`formulaMode: normal` 仍兼容旧版“仅物品接口”。不执行配方过滤或产线模拟。

完整预览支持 `presentation.viewport: {zoom: 1..4, x: 0..1, y: 0..1}`，位置表示可滚动范围的比例；缺省为完整显示、居中。预览和 PNG 共用同一绘制函数，取景不改变设备统计。`presentation.showChangeHints` 缺省为 false，对应 BlueprintPreview.lua 中 `m_canEdit` 为 false 时隐藏更换图标角标的行为。

四向建筑、物品徽标等预渲染 PNG 生成到 `dist/baked/`。最终 HTML 内嵌所有运行资源，单独复制该 HTML 也可使用；继续开发请保留整个项目目录。

2026-09-20 补接 ItemNode 的 LockedNode、TimeLimitedActiveNode、TimeLimitedExpiredNode 原始状态层，保持原图尺寸、偏移与颜色。仅以手动标记显示，详见 `display-audit.md`。

原始暗管激活轮廓的两层收缩/透明度曲线保存于 `assets/blueprint_source/udpipe_effect_animation.json`，按 Hermite 插值取 0.5 秒，生成可重复的静态效果。`img_udpipe` 光带使用原始九宫格边界；不重现额外 shader 扫光。85 项预览组件的接入边界由 `src/audit_display_effects.py` 生成报告。
