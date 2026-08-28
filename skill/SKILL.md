---
name: browser-attach
description: 通过 CDP 附加到用户真实 Chrome(attach 模式,复用现有登录态)来查看和操作网页:读取页面文字、截图(整页/元素)、可访问性快照([ref]编号)、点击、输入、执行 JS、等待加载。当用户要求"看某个网页/网址内容""打开这个链接""帮我在页面上点一下/填一下""截图看看""浏览一下某某页面"时使用,尤其是需要登录态或真实视觉效果的时候。Use when the user wants to read or operate their real Chrome browser over attach-mode CDP, reusing existing logins.
---

# Browser Attach(浏览器附加控制)

通过 CDP(Chrome DevTools Protocol)附加到用户**正在使用的真实 Chrome**(调试端口 `127.0.0.1:9222`),所有页面都带用户现有的登录态。这是 attach 模式,不是隔离/无头浏览器。

优先使用 DSH 原生工具(插件 `dsh-browser-attach` 注册；若本会话看不到这些工具，告诉用户重启 `dsh web` 后才会出现，不要自己重启):`browser_doctor` / `browser_tabs` / `browser_open` / `browser_read` / `browser_shot` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_eval` / `browser_wait` / `browser_activate` / `browser_close`。

本会话如果还看不到这些工具,回退 CLI:`node <本插件目录>/browserctl.mjs <command> ...`(与插件走同一条 daemon 连接)。审计/pid 仍在 `~/.config/browserctl/`。

## 何时使用(与替代品的分工)

- **用 browser-attach**:需要**登录态**(已登录的后台、个人主页)、需要**真实交互**(点击/填写/提交)、需要**视觉确认**(布局、图片、弹窗、截图)。
- **不用 browser-attach**:普通资讯检索、查资料 → 用 `web_search`(更便宜更快);纯文本抓取公开页面 → 也可考虑 `curl`,但从浏览器读更接近用户所见,优先浏览器。
- 先 `doctor` 确认可用(本会话内确认过可跳过);不可用时按 `doctor` 输出修复,涉及重启用户 Chrome 必须**先问用户**。

## 第一步

```bash
node <本插件目录>/browserctl.mjs doctor
```

## 授权弹窗与常驻连接(重要)

Chrome 151+ 对外部程序通过调试端口连接新增了安全确认弹窗「要允许远程调试吗?」。机制:**每次新建 CDP 连接都会弹一次**,Chrome 目前不持久化授权(社区已知问题,见 chrome-devtools-mcp #825)。

- browserctl 已内置 **daemon 常驻单连接**(127.0.0.1:9223,自动拉起):用户只需在每次 Chrome 启动后**点一次「允许」**,之后所有命令复用同一连接,不再弹窗;Chrome 重启/断连后重连时会再弹一次(提醒用户点「允许」)。
- 弹窗中的「**在"设置"中关闭**」会彻底禁用远程调试端口 → 所有命令失效,不要点。
- daemon 状态:pid 存于 `~/.config/browserctl/daemon.pid`;`kill $(cat ~/.config/browserctl/daemon.pid)` 可停掉。
- 若用户频繁反馈弹窗:检查 daemon 是否存活(常驻进程被系统或用户杀掉后,下一个命令会自动重新拉起并**重新弹一次**)。

## 命令矩阵

### 三种"看"
| 需求 | 命令 | 备注 |
|---|---|---|
| 看文字内容(默认,省 token) | `read [--url <子串>] [--max n]` | 返回 title/url/readyState/innerText |
| 文字+画面一起 | 先 `read` 再 `shot` | 最常见组合;我自带视觉,截图直接读图 |
| 只看画面 | `shot [--full] [--sel <css>] [--out <路径>]` | 截图落盘到 `./browser-shots/`,再用 read_image 查看 |
| 交互地图(可点元素) | `snapshot` | 返回带 `[ref]` 编号的无障碍树 |

### 交互与深度
| 需求 | 命令 |
|---|---|
| 点击 | `click <css> \| <@ref> \| <文本> --text`(文本匹配需 `--text`) |
| 输入 | `type <文本> [--sel <css>]`(React 安全:原生 setter + input/change 事件) |
| 执行 JS | `eval <表达式>`(逃离通道;只读优先) |
| 等待 | `wait [--state complete] [--sel <css>] [--timeout ms]`(点击后必等) |
| 标签管理 | `tabs` / `open <url> [--activate]` / `activate <id或url子串>` / `close <id或url子串>` |

### 目标选择
`--url <子串>` 指定标签(模糊匹配);缺省用上一次操作的标签,再缺省用最后一个页面标签。`activate` 会把标签带到前台(用户屏幕上可见)。

## 纪律(务必遵守)

1. **只读默认**:`read`/`shot`/`snapshot`/`tabs`/`open` 无需确认(仅打开 URL 前简述进什么页面)。
2. **敏感操作先确认**:`click`/`type`/`eval` 之前,先向用户说明"我要在哪个页面点/填什么";对**发布、删除、支付、转账、改权限/设置**类操作,必须得到用户明确同意才执行。
3. **敏感字段不代填**:密码、验证码、支付信息不通过 `type` 代填;引导用户自行输入。
4. **最小暴露**:读取用户已登录的私人页面时,只取任务所需内容(`--max` 控制),不在对话里转述无关私人信息。
5. **留痕**:每次操作写入 `~/.config/browserctl/audit.jsonl`(JSONL),截图在 `./browser-shots/`;用户问"你刚才干了什么"时先查审计再回答。
6. **端口不可用时的处理**:`doctor` 不通过 → 告诉用户需要 Chrome 带 `--remote-debugging-port=9222` 启动;如需重启 Chrome 或使用专用 profile,先征得同意(会关闭用户当前会话)。
