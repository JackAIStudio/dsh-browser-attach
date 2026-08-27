# dsh-browser-attach

DeepSeek Harness 插件：通过 CDP **附加到用户正在用的真实 Chrome**（复用登录态），给 Agent 注册一组 `browser_*` 工具。

不是隔离/无头浏览器。底层是本仓库的 `browserctl.mjs`：常驻 daemon 只持有 **一条** CDP 连接，Chrome 授权弹窗每个会话点一次「允许」。

审计与状态仍写在 `~/.config/browserctl/`（`audit.jsonl` / `state.json` / `daemon.pid`），不进 Git。

## 工具

| 工具 | 用途 |
|---|---|
| `browser_doctor` | 检查 CDP / daemon / 当前标签 |
| `browser_tabs` | 列出页面标签 |
| `browser_open` | 打开 URL（会在用户屏幕上弹出） |
| `browser_read` | 读文字；`format=both` 同时截图；`format=visual` 只截图 |
| `browser_shot` | 截图（整页或 CSS 元素） |
| `browser_snapshot` | 无障碍树 + `[ref]` 编号 |
| `browser_click` / `browser_type` / `browser_eval` | 交互（发布/支付类操作须用户确认） |
| `browser_wait` / `browser_activate` / `browser_close` | 等待 / 切前台 / 关标签 |

## 文件

- `index.js` — DSH host 插件，注册 `browser_*` 工具
- `browserctl.mjs` — 零依赖 CDP CLI + daemon（`127.0.0.1:9223`）
- `cordis.patch.yml` — 装进 web profile 的 bundle 补丁
- `skill/SKILL.md` — Agent 使用说明（安装到 `~/.agents/skills/browser-attach/`）

## 安装（本机 file: 包）

在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里加入本包，然后：

```bash
pnpm install --dir ~/.dsh/profiles/web
```

重启 `dsh web` 后工具生效。配套 skill：

```bash
mkdir -p ~/.agents/skills/browser-attach
cp skill/SKILL.md ~/.agents/skills/browser-attach/SKILL.md
```

CLI 回退（与插件走同一条 daemon）：

```bash
node ./browserctl.mjs doctor
```

## 前提

Chrome 以 `--remote-debugging-port=9222` 运行。首次连接会弹「要允许远程调试吗?」——点「允许」，不要点「在设置中关闭」。
