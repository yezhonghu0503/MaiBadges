# 本地预览

在仓库根目录构建后，用回环 HTTP 服务打开公开示例：

```sh
python3 build_package.py
python3 -m http.server 8795 --bind 127.0.0.1 --directory plugins/work-badges/previews
```

浏览器访问 `http://127.0.0.1:8795/holo-badge-preview.html` 查看共享浮动渲染器，或 `http://127.0.0.1:8795/manager-preview.html` 查看只读管理页示例。服务只监听本机；结束时在运行服务的终端按 Ctrl+C。

示例不读取真实资料库、不保存聊天绑定。管理真实角色请安装本地插件并调用 `work_badges_open`。预览使用合成通用资料，不能证明实际聊天窗口的 DOM、调试端口或登录自启兼容。

建议检查明暗主题、窄布局、头像回退、长职责、翻面、拖动、折叠、关闭恢复、缓存切回，以及系统“减少动态效果”。截图和录像应只使用公开示例，不录入私人聊天标题或个人头像。
