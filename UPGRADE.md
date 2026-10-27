# 升级到 MaiBadges 0.8.0

公开版从 **0.7.0** 开始。0.7.0 只有右侧浮动工牌，未包含左侧员工卡片；0.8.0 补入左侧已绑定员工卡片，并减少重复传输、渲染与资料读取。升级必须一起更新完整源码或安装包，运行 `prepare`、通过宿主正常功能更新插件，再重启加载器。`install-launcher` 只处理入口，不能替代这些步骤。

保留同一个 `--state-dir`，可保留角色、头像、绑定、位置和显示状态。默认路径为 `~/Library/Application Support/MaiBadges`。公开几何样例不会覆盖已保存的自定义资料；升级不需要重新上传头像或重新创建已有绑定。

## 1. 确认路径，停止加载器

下载或检出完整的 0.8.0 源码或安装包，进入其根目录，使用 [INSTALL.md](INSTALL.md) 第 1 节的变量。不要只替换一个启动器或复制一份界面文件。若此前使用自定义资料目录，将 `MAIBADGES_STATE` 指向原目录，不能用一个空目录冒充迁移完成。

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_RUNTIME/loader/control.py" disable-login --state-dir "$MAIBADGES_STATE"
"$MAIBADGES_PYTHON" "$MAIBADGES_RUNTIME/loader/control.py" stop --state-dir "$MAIBADGES_STATE"
"$MAIBADGES_PYTHON" "$MAIBADGES_RUNTIME/loader/control.py" status --state-dir "$MAIBADGES_STATE"
```

只安装管理插件的用户可跳过加载器命令。等待加载器停止；不要删除锁文件或强杀无关进程。

## 2. 备份资料并准备新版

先关闭管理页并停止相关本地服务，确保资料库不再写入，再备份完整状态目录。macOS 可使用：

```sh
MAIBADGES_BACKUP="${MAIBADGES_STATE}.backup-$(date +%Y%m%d-%H%M%S)"
ditto "$MAIBADGES_STATE" "$MAIBADGES_BACKUP"
"$MAIBADGES_PYTHON" "$MAIBADGES_PACKAGE/setup.py" prepare \
  --project-dir "$MAIBADGES_PROJECT" --state-dir "$MAIBADGES_STATE"
"$MAIBADGES_PYTHON" "$MAIBADGES_PACKAGE/setup.py" check-install --state-dir "$MAIBADGES_STATE"
```

如果无法确认服务已停止，先自行退出宿主再备份。准备失败时保留输出和原资料。文件检查成功只说明复制一致，不代表旧管理页已加载新代码。

## 3. 更新插件并重新启动加载器

通过宿主正常功能更新或重新安装同一来源的 `work-badges`，不要修改宿主插件缓存。关闭旧管理页，再调用 `work_badges_open`。

使用浮动加载器的用户可刷新入口：

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_PACKAGE/setup.py" install-launcher --state-dir "$MAIBADGES_STATE"
```

`install-launcher` 只更新入口和图标。运行过 `prepare` 且宿主已更新插件后，使用桌面加载器的用户还需重新启动它。已有调试会话与登记仍有效时，仅本次后台运行可执行：

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_RUNTIME/loader/control.py" start \
  --state-dir "$MAIBADGES_STATE" --port 9347
```

此前使用登录自启、并希望恢复它时，改为执行：

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_RUNTIME/loader/control.py" enable-login \
  --state-dir "$MAIBADGES_STATE" --port 9347
```

`enable-login` 同时提交启动请求，无需再 `start`。端口不可用时按安装说明自行保存工作、退出目标应用，再从 `MaiBadges.app` 打开；窗口登记失效时按安装说明重新 `enroll`。不要为了刷新普通管理资料强制终止其他任务。

## 4. 验收

确认角色、头像和绑定保留；检查右侧工牌的拖动、翻面、折叠、关闭恢复及减少动态效果。左侧只应装饰可识别、无歧义且已确认绑定的导航行，点击仍能打开聊天，定时任务图标保留；未绑定、停用或同名有歧义的行保持原样。未绑定聊天不应显示上一角色。

换头像后不应残留旧素材。再次切回已打开聊天可命中会话缓存，重启后的首次图片解码属于正常情况。宿主结构不兼容时保留诊断信息，不把离线检查或预览成功当作所有桌面客户端均通过验收。

本项目不提供从其他个人定制包到公开版的自动迁移。若选择继续使用旧资料目录，应先备份，显式传入该路径，并检查插件、加载器和管理页都使用同一目录。不要把私人数据库或素材加入公开仓库。
