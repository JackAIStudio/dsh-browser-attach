# dsh-browser-attach 仓库与 Agent 维护规范（AGENTS.md）

> 本文件是本插件的**代码架构与维护硬性规范**。
> 所有 AI Agent 与人类贡献者在修改、重构或新增功能时，**必须严格遵守以下规则**。

---

## 1. 零单文件膨胀原则（Strict File Size Limits）

1. **单文件行数上限**：
   - 任何单个源码文件严禁超过 **300 行**。
   - 现有较大文件（如 `browserctl.mjs`）后续迭代时**必须拆分，禁止继续在末尾无脑追加代码**。
2. **单一职责与模块化目录建议**：
   - **工具注册入口 (`index.js`)**：保持极简（< 100 行），仅负责 Cordis 插件生命周期绑定、schema 定义与工具注册分发。
   - **底层通信 (`lib/cdp.js` 或 `src/cdp.js`)**：专职负责 CDP WebSocket/HTTP 连接管理、Target 发现与生命周期。
   - **动作执行 (`lib/actions.js`)**：负责 `click`、`type`、`open`、`close`、`wait`、`eval` 等浏览器操作。
   - **DOM 与视觉快照 (`lib/snapshot.js`)**：负责可访问性树（AXTree）解析、截图（shot/read）、Ref 引用编号映射。
   - **诊断与探活 (`lib/doctor.js`)**：专职负责 `browser_doctor` 状态自检与友好错误提示。

---

## 2. 运行宿主与跨平台铁律

本插件运行在跑 `dsh web` 的宿主机（macOS、Windows、Linux），必须保持跨平台兼容：

1. **跨平台进程与端口探测**：
   - CDP 默认调试端口（如 `9222`）探测必须使用标准 `node:net` / `fetch`，严禁直接调用仅 macOS 可用的命令。
   - 打开新 Chrome 实例时，必须兼顾 macOS (`open -a "Google Chrome"` / `--remote-debugging-port`), Windows (`chrome.exe`), Linux (`google-chrome` / `chromium`)。
2. **无 GUI / 云端环境优雅降级**：
   - 当运行在无本地 Chrome 的无 GUI 云主机时，工具调用不得直接 crash 崩溃整个进程，必须通过 `browser_doctor` 或清晰的错误提示告知当前环境未检测到 Chrome 调试端口。
3. **路径与安全性**：
   - 截图输出路径统一使用 `node:path`，严格遵循沙箱安全策略。

---

## 3. 原生 ESM 规范与修改后自检

1. **原生 ESM**：所有本地模块 `import` 必须带显式 `.js` / `.mjs` 扩展名。
2. **修改后门禁自检**：
   修改任何代码后，必须在插件根目录下运行以下命令进行语法自检：
   ```bash
   find . -name "*.js" -o -name "*.mjs" -not -path "*/.*" -not -path "*/node_modules/*" -exec node --check {} +
   ```
