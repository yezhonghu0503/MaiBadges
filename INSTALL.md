# 安装 MaiBadges 0.7.0

本项目包含一个本地 MCP 管理插件，以及可选的桌面浮动加载器。可以只使用管理页。浮动集成目前面向 macOS，依赖目标宿主接受调试启动参数；它不是官方原生侧栏扩展接口。

## 1. 准备环境与路径

安装 Python 3.9+，克隆或解压完整源码。进入仓库根目录，在同一个终端依次执行：

```sh
MAIBADGES_PACKAGE="$PWD"
MAIBADGES_PROJECT="$MAIBADGES_PACKAGE"
MAIBADGES_STATE="$HOME/Library/Application Support/MaiBadges"
MAIBADGES_RUNTIME="$MAIBADGES_STATE/runtime"
MAIBADGES_PYTHON="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.executable).resolve())')"
"$MAIBADGES_PYTHON" -c 'import sys; assert sys.version_info >= (3, 9), "Python 3.9+ required"; print(sys.version)'
```

运行与安装不需要 Node.js、npm、API Key 或 Python 第三方库。修改源码并重新构建时需要 Node.js 20+ 进行开发验证。后续命令复用本节变量；新开终端需重新定义。

## 2. 准备本地管理插件

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_PACKAGE/setup.py" prepare \
  --project-dir "$MAIBADGES_PROJECT" --state-dir "$MAIBADGES_STATE"
"$MAIBADGES_PYTHON" "$MAIBADGES_PACKAGE/setup.py" check-install \
  --state-dir "$MAIBADGES_STATE"
```

`prepare` 将插件登记到项目的 `.agents/plugins/marketplace.json`，复制独立运行时，设置本地 MCP 的 Python 与资料路径，准备专属启动器。它不会打开应用、连接调试端口、启动加载器或配置登录自启。修改已有插件目录项时保留其他条目，并创建备份。

`check-install` 比较源包和本地运行时文件；文件一致不等于当前宿主已经加载新版。报错或文件不一致时先保留输出，不删除锁文件或资料库。

## 3. 安装插件，打开管理页

在支持本地插件的桌面宿主中打开 `MAIBADGES_PROJECT` 对应项目，使用其正常的本地插件安装功能，选择准备步骤输出的来源名称。新来源默认 `maibadges-local`，已有目录以终端输出为准。安装 `work-badges`，显示名称为 **MaiBadges**。

若已安装 Codex CLI，也可在同一项目目录中执行：

```sh
codex plugin add work-badges@maibadges-local
```

仅在准备步骤确实输出该来源名时使用这条命令。宿主可能需要授予项目文件访问或确认本地 MCP 服务；登录、验证与权限决定均由你完成。不存在对应插件功能或本地服务不受支持时，停止此步骤，不修改宿主安装文件。

在聊天中请求：

> 调用 work_badges_open，显示 MaiBadges 管理页。

可新增角色、编辑头像与职责，点击“保存工牌”。切换到聊天绑定页，明确填写目标聊天的**完整标题**并点击“保存聊天绑定”。两个保存动作分别处理资料与绑定。管理页不会自行启动浮动加载器。

**只需要管理工牌，到这里即可。**

## 4. 可选：创建桌面入口并打开调试会话

浮动工牌需要 CDP。调试端口授予的能力比本项目正常使用的窗口标题和挂载操作更广，因此只在信任本机环境、接受该权限时继续。端口限制为 `127.0.0.1:9347`，不应转发到局域网或公网。详见 [SECURITY.md](SECURITY.md)。

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_PACKAGE/setup.py" install-launcher \
  --state-dir "$MAIBADGES_STATE"
```

该步骤在 `~/Applications/MaiBadges.app` 建立专属启动器软链。Finder 中按 Cmd+Shift+G，输入 `~/Applications` 即可找到，也可拖入 Dock。启动器请求打开已安装的目标应用并附加回环调试参数，不复制官方应用、不修改其安装包，也不强制退出已有实例。

首次启用调试会话，先保存工作并自行完全退出目标应用，再打开入口：

```sh
open "$HOME/Applications/MaiBadges.app"
```

若现有进程未接受调试参数，需要先自行退出再打开。启动器不保证所有宿主版本支持；若宿主拒绝，停止，不关闭安全策略或修改应用本体。

## 5. 显式登记主窗口并启动加载器

打开要使用的聊天主窗口。登记只选择窗口，不创建角色绑定：

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_RUNTIME/loader/main.py" enroll \
  --state-dir "$MAIBADGES_STATE" --port 9347
```

阅读列出的窗口标题，输入对应序号；回车取消。不要选择不相关窗口。然后选择一种启动方式。

仅本次后台运行：

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_RUNTIME/loader/control.py" start \
  --state-dir "$MAIBADGES_STATE" --port 9347
```

需要每次登录后恢复时，显式启用自己的登录项：

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_RUNTIME/loader/control.py" enable-login \
  --state-dir "$MAIBADGES_STATE" --port 9347
```

`enable-login` 同时启动加载器；无需重复 `start`。重启恢复要求加载器运行、调试端口可用、窗口登记有效、目标聊天已有绑定。常规应用入口未必附带调试参数。

## 6. 使用与检查

回到已绑定聊天，工牌首次出现后可按住顶部拖到右侧需要的位置。单击卡面翻面；按住卡面转动观察材质；右上角可折叠或关闭。关闭后原位置的“显示工牌”可恢复。长期隐藏可停用角色或解除绑定。系统“减少动态效果”会限制动画。

查看本地状态快照：

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_RUNTIME/loader/control.py" status \
  --state-dir "$MAIBADGES_STATE"
```

| 状态 | 含义与处理 |
| --- | --- |
| `mounted` | 最近一次已挂载；结合更新时间和实际界面确认 |
| `unbound` | 当前标题没有已保存绑定；检查完整标题、角色启用状态及是否点击绑定保存 |
| `waiting-debug-port` | 本机调试端口不可用；检查专属入口与窗口是否打开 |
| `ambiguous-target` | 多个候选窗口，需停止后重新登记明确主窗口 |
| `invalid-configuration-or-endpoint` | 窗口登记或回环端口不匹配；停止并核对配置 |
| `waiting-registry` | 资料库暂不可读；检查本地路径、空间和权限 |
| `page-or-protocol-error` | 页面或协议不受支持；保留日志，不能视为安装成功 |
| `blocked-review-required` | 加载器已暂停，先核查 `failure.json`，不绕过拒绝或连续重试 |
| `stopped` | 已停止；若需要显示，再显式启动 |

`status` 只读取本地文件，不主动探测端口或进程。日志在状态目录的 `launcher.log`、`service.stdout.log`、`service.stderr.log`。分享诊断前删除用户名、聊天标题和头像等个人信息。

确认暂停原因已经解决后，才手动重试：

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_RUNTIME/loader/main.py" retry \
  --state-dir "$MAIBADGES_STATE" --port 9347
```

## 7. 停用、卸载与保留资料

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_RUNTIME/loader/control.py" disable-login \
  --state-dir "$MAIBADGES_STATE"
"$MAIBADGES_PYTHON" "$MAIBADGES_RUNTIME/loader/control.py" stop \
  --state-dir "$MAIBADGES_STATE"
```

先停用登录项，再确认 `status` 为 `stopped`。单独 `stop` 保留登录配置。停止后若页面残留浮层，关闭相关会话或自行重启目标应用即可清除；普通工牌的关闭按钮只是隐藏卡片，不等于停用调试端口。

在宿主正常插件管理界面卸载插件。需要移除本项目登记及启动器时：

```sh
"$MAIBADGES_PYTHON" "$MAIBADGES_PACKAGE/setup.py" remove-marketplace \
  --project-dir "$MAIBADGES_PROJECT" --state-dir "$MAIBADGES_STATE"
"$MAIBADGES_PYTHON" "$MAIBADGES_PACKAGE/setup.py" uninstall-launcher \
  --state-dir "$MAIBADGES_STATE"
"$MAIBADGES_PYTHON" "$MAIBADGES_PACKAGE/setup.py" remove-launchers \
  --project-dir "$MAIBADGES_PROJECT" --state-dir "$MAIBADGES_STATE"
```

这些操作保留角色数据库、头像和其他插件。完全退出调试会话后，用宿主常规入口打开，可不再提交本项目调试参数。需要删除个人资料时，先备份，再自行删除确认过的状态目录；不要用清空资料库作为普通排障手段。

升级见 [UPGRADE.md](UPGRADE.md)。

同一个宿主窗口会话只启用一套 `work-badges` 浮动加载器；请先停止旧加载器，再切换安装来源。公开版独立状态目录不代表两套加载器可以同时控制同一窗口。
