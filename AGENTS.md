# AGENTS.md

必须依据 `https://deepseek-harness.github.io/deepseek-harness/reference/` 参考文档进行开发。

## 上下文索引

- **架构、模块职责与错误契约**：修改任务生命周期、接口契约或模块边界前，阅读 `docs/codebase.md`。
- **模型体验、提示词与已知限制**：调整 Master/Worker 提示词、工具可见性或审视已知边界时，阅读 `README.md`。
- **工程范围**：源码与构建配置位于 `src/`、`tests/`、`presets/`、`scripts/` 与根目录配置文件；`workspace/` 与 `ideas/` 为研究资料，检索代码时优先限定在工程目录。

## 关键架构约束

### 双端编译与共享契约
- **Host（Node ESM）**：`src/`（`src/client/` 除外）按 `tsconfig.json`（`module: nodenext`）编译至 `dist/`，相对导入必须带 `.js` 后缀。
- **Client（Browser UMD）**：`src/client/` 按 `tsconfig.client.json`（`moduleResolution: Bundler`）校验，并由 `scripts/build-client.mjs` 打包为 `window.__ModuleLoader__` 格式的 `dist/client.js`。前端代码使用无后缀相对导入并保持纯浏览器依赖；新增宿主共享外部依赖或前置注入服务时，分别同步 `scripts/build-client.mjs` 的 `PLATFORM_EXTERNALS` 与 `package.json` 的 `dsh.client.inject`。
- **共享协议**：`src/remote.ts` 同时被 Host 与 Client 引用，仅使用跨端安全类型及 `@deepseek-ai/dsh-typert-protocol/remote-info`、`zod` 等共享依赖。

### DSH 扩展与隔离边界
- **非侵入式 Bundle**：`cordis.patch.yml` 仅挂载 `dsh-plugin-deepduet`；所有前端 UI 通过 `ctx.slots.inject`、`ctx.sidebarRightTabs`、`ctx.locale` 与 `inject: () => ({ hooks: { deepduet: store.snapshot }, ... })` 接入宿主，保持宿主 `web-runtime` 与内建 UI 包原样。
- **Preset 作用域与 Worker 隔离**：Master 编排面通过 `presets/deepduet.patch.yml` 引入 `dsh-plugin-deepduet/tools`（`src/tools.ts`）挂载，仅在宿主未启用 `agentPresets` 时才在 `src/index.ts` 直接挂载；Worker 会话在 `src/dsh.ts` 强制隔离为 `standard` preset，并显式继承父会话的 `sandboxMode` 与 `approvalPolicy`。
- **KV Cache 稳定性**：`MASTER_PROMPT` 与 `WORKER_PROMPT` 保持静态字符串且 `interpolate: false`；工具门禁 `when: ({ agent }) => isMaster(agent)` 在会话期恒定；动态任务状态仅通过空闲门禁的 `[Background Digest]`（`master.followup`）或 `session_inspect` 进入对话。

### 状态持久化、沙箱与命名
- **账本与 Worktree**：`.dsh/deepduet-ledger.json` 固定保存在项目根目录，由 `src/ledger.ts` 串行化原子落盘；所有 Git 操作通过 `DshHost.runGit` 执行，在非 `danger-full-access` 模式下走 `ctx.sandbox.confine` 并剥离局部 `GIT_*` 环境变量；清理 Worktree 前必须经过 `agent.runMaintenance` 与 Git 注册校验。
- **命名一致性**：全仓库统一使用 `DeepDuet` / `deepduet` / `dsh-plugin-deepduet` 命名（`tests/deepduet-mode.test.js` 对此有自动校验）。

## 验证标准

- 完成任何源码、Preset 或构建配置修改后，执行并确保通过全量检查与测试：
  ```sh
  npm run typecheck && npm test
  ```
- `npm test` 会先运行 `npm run build` 重建 `dist/`（含 `dist/client.js`），再运行 `node --test tests/*.test.js`；汇报完成前须确认 `tsconfig.json`、`tsconfig.client.json`、`dist/client.js` 打包及全部测试均基于最新修改通过。
- 测试分层：纯状态机与队列逻辑在 `tests/` 中配合 `tests/support/fake-host.js` 验证；DSH Agent Loop、Preset 隔离、Typert RPC 与 `dist/client.js` 插槽加载通过 `@deepseek-ai/dsh-agent-loop-testkit` 在 `tests/dsh.test.js`、`tests/gui-remote.test.js`、`tests/deepduet-mode.test.js` 中验证。
