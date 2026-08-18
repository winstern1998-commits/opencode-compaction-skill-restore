# opencode-compaction-skill-restore

OpenCode 服务端插件：auto compaction 后改写合成 continue 消息，提醒模型重新加载压缩前加载过的 skill。

## 项目定位

本插件解决一个问题：auto compaction 会丢弃 skill 的上下文（SKILL.md 内容、文件列表、路由规则），导致模型在压缩后继续工作时丢失 skill 指引。插件通过改写合成 continue 消息的 text，让模型在继续前先重新加载原 skill。

这是一个**服务端插件**（server-side plugin），不是 TUI 插件。入口是 `src/index.ts`，`package.json` 的 exports 指向 `./src/index.ts`。

## 工作原理

两个钩子协作：

| 钩子 | 作用 |
|---|---|
| `tool.execute.after` | 监听 `skill` 工具成功执行，按 `sessionID` 记录最近加载的 skill 名（从返回的 metadata.name 获取）。用 after 而非 before，确保只在加载成功后记录 |
| `experimental.chat.messages.transform` | 每轮 LLM 调用前触发，识别**最后一条 user 消息**中的合成 part（`part.synthetic === true && part.metadata?.compaction_continue === true`）并就地改写 `part.text`。只处理最后一条 user 消息，避免在 compaction LLM 调用场景误改历史消息 |

合成消息的生成处：opencode 源码 `packages/opencode/src/session/compaction.ts`（metadata `compaction_continue: true` + `synthetic: true`）。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口，两个钩子的实现 |
| `opencode.example.json` | 插件配置示例 |
| `tsconfig.json` | TypeScript 配置（strict, NodeNext, noEmit） |
| `package.json` | 依赖 `@opencode-ai/plugin` + `@opencode-ai/sdk`（1.17.13） |

## 开发约定

- **语言**：TypeScript strict 模式，不引入 `any`（SDK Hooks 签名中的 `args: any` 是外部类型，收窄为 `Record<string, unknown>` 后使用）
- **包管理**：`bun install`，`bun run typecheck`（即 `tsc --noEmit`）
- **模块系统**：ESM（`"type": "module"`），`module: "NodeNext"`
- **修改约束**：只修改完成当前任务所必需的部分，不做附带重构
- **类型安全**：`output.metadata` 通过 `as { name?: unknown } | undefined | null` 收窄；`sessionSkills.get()` 返回 `string | undefined`，用 `!== undefined` 守卫

## 注意事项

- `experimental.chat.messages.transform` 和 `compaction_continue` metadata 标记**不是稳定插件契约**，可能在 future opencode 版本中变更或移除
- skill 追踪是内存级的（Map），opencode 服务重启后丢失，回退到通用文案
- 只追踪通过 `skill` 工具加载的 skill，其他方式（如手动粘贴）不会被追踪
- 多个 skill 加载时，只记录最近一次加载的
- sessionSkills Map 无清理机制，长期运行可能累积 stale 条目（单条内存开销小，已知技术债）
