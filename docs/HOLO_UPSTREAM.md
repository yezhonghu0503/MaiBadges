# Holo Card 来源与改编

材质渲染代码改编自 [LerSent001/holo-card](https://github.com/LerSent001/holo-card)，采用的来源版本固定为 [`9d2b79997c2cb97453777ea6225b369e747cb1ce`](https://github.com/LerSent001/holo-card/tree/9d2b79997c2cb97453777ea6225b369e747cb1ce)。原 MIT 版权为 **Copyright (c) 2026 Holo Card contributors**，完整许可证保存在 [Holo-Card-MIT.txt](../plugins/work-badges/licenses/Holo-Card-MIT.txt)。

`runtime/holo-engine.js` 改编其 WebGL 着色器、RGBM/HDR 发光与多尺度 bloom，并适配本项目的共享工牌渲染器。主体、背景、框线和文字分层，按视角变化绘制；姓名与职责仍由实时 DOM 维护。隐藏、背面、折叠与静止状态限制无必要绘制，图像与会话缓存设有上限。

创意启发致谢 **@乌托邦的香蕉**，上游说明其在小红书和 B 站使用同名。该署名仅表示创意启发，不表示其参与或背书本项目；没有猜测个人主页链接。

公开版不复制或分发上游默认卡背、示例卡片、视频、人物或其他角色作品。代码 MIT 许可不授予这些作品的权利。公开示例为本项目用代码生成的原创几何素材，许可范围见 [ASSETS_LICENSE.md](../ASSETS_LICENSE.md)。

本文件说明代码来源与适配，不证明当前构建已完成浏览器或桌面兼容性验收。测试与视觉检查应针对实际发布构建单独执行和记录。
