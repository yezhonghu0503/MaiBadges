# 升级 MaiBadges

公开版从 **0.7.0** 开始。保留同一个 `--state-dir`，可保留角色、头像、绑定、位置和显示状态。公开几何样例不会覆盖已保存的自定义资料。`install-launcher` 只处理入口，界面更新需要 `prepare` 和宿主正常的插件更新。

## 1. 确认路径，停止加载器

进入新版源码根目录，使用 [INSTALL.md](INSTALL.md) 第 1 节的变量。若此前使用自定义资料目录，将 `MAIBADGES_STATE` 指向原目录，不能用一个空目录冒充迁移完成。

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

## 3. 更新插件与可选入口

通过宿主正常功能更新或重新安装同一来源的 `work-badges`，不要修改宿主插件缓存。关闭旧管理页，再调用 `work_badges_open`。

使用浮动加载器的用户可刷新入口：

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_PACKAGE/setup.py" install-launcher --state-dir "$MAIBADGES_STATE"
```

已有调试会话与登记仍有效时，可重新 `start` 或恢复 `enable-login`；端口不可用时按安装说明自行保存工作、退出目标应用，再从 `MaiBadges.app` 打开。不要为了刷新普通管理资料强制终止其他任务。

## 4. 验收

确认角色和绑定保留；检查拖动、翻面、折叠、关闭恢复、减少动态效果及未绑定聊天不显示旧角色。换头像后不应残留旧素材。再次切回已打开聊天可命中会话缓存，重启后的首次图片解码属于正常情况。

本项目不提供从其他个人定制包到公开版的自动迁移。若选择继续使用旧资料目录，应先备份，显式传入该路径，并检查插件、加载器和管理页都使用同一目录。不要把私人数据库或素材加入公开仓库。
