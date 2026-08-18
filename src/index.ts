import type { Hooks, Plugin } from "@opencode-ai/plugin"

/**
 * 幂等守卫标记：restorePrefix 的固定前缀。守卫检查和 restorePrefix 都引用
 * 此常量，避免措辞修改时忘记同步守卫导致幂等失效。
 */
const RESTORE_MARKER = "Before continuing:"

/**
 * opencode-compaction-skill-restore
 *
 * 当 auto compaction 完成后插入合成 user 消息（"Continue if you have next
 * steps..."）时，改写其 text，加入"如果压缩前加载了某个 skill，先重新加载原
 * skill 恢复上下文再继续"的指令。
 *
 * 机制：
 * 1. tool.execute.after 钩子监听 skill 工具调用，按 sessionID 记录最近加载的
 *    skill 名（从 execute 返回的 metadata.name 获取，确保只在加载成功后记录）。
 * 2. experimental.chat.messages.transform 钩子在每轮 LLM 调用前被触发，传入
 *    完整 msgs 数组（含刚插入的合成消息）。插件在此钩子里识别合成消息
 *    （part.synthetic === true && part.metadata?.compaction_continue === true）
 *    并就地修改 part.text，在 "Continue if you have..." 前插入 skill 恢复指令。
 *
 * transform 钩子有两个调用点：
 * - prompt.ts:1255 — 工作 LLM 调用前（插件设计目标）：合成 continue 消息是
 *   最新插入的，一定是 msgs 中最后一条 user 消息。
 * - compaction.ts:350 — compaction LLM 调用前（非预期）：传入的是
 *   selected.head（待总结的历史消息），其中的历史合成消息不是最后一条 user
 *   消息。插件只改写最后一条 user 消息中的合成 part，从而跳过此场景。
 *
 * 合成消息的生成处见 opencode 源码 packages/opencode/src/session/compaction.ts
 * （metadata: { compaction_continue: true }, synthetic: true）。
 */
export default (async () => {
  // sessionID -> 最近一次通过 skill 工具加载的 skill 名
  const sessionSkills = new Map<string, string>()

  const hooks: Hooks = {
    // 改用 after 而非 before：before 在 ctx.ask 权限检查之前触发，用户拒绝
    // 权限时仍会记录 skill 名。after 只在 execute 成功完成后触发，从返回的
    // metadata.name 获取 skill 名（见 skill.ts:62-65）。
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "skill") return
      // output.metadata 类型为 any（SDK Hooks 签名），收窄后访问 name。
      const metadata = output.metadata as
        | { name?: unknown }
        | undefined
        | null
      const name = metadata?.name
      if (typeof name === "string" && name.length > 0) {
        sessionSkills.set(input.sessionID, name)
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      // 只处理 msgs 中最后一条 user 消息：在 prompt.ts:1255 的调用中，合成
      // continue 消息是最新插入的，一定是最后一条 user 消息；在
      // compaction.ts:350 的调用中，历史合成消息不是最后一条（后面还有新
      // 对话），跳过以避免干扰 compaction 总结和语义错位。
      let lastUserIdx = -1
      for (let i = output.messages.length - 1; i >= 0; i--) {
        if (output.messages[i].info.role !== "user") continue
        lastUserIdx = i
        break
      }
      if (lastUserIdx < 0) return

      const lastUserMsg = output.messages[lastUserIdx]
      const sessionID = lastUserMsg.info.sessionID
      for (const part of lastUserMsg.parts) {
        // 只处理合成 text part
        if (part.type !== "text") continue
        if (!part.synthetic) continue
        if (part.metadata?.compaction_continue !== true) continue

        // 幂等保护：如果 text 已被本插件改写过则跳过
        if (part.text.includes(RESTORE_MARKER)) continue

        const skillName = sessionSkills.get(sessionID)
        const restorePrefix =
          skillName !== undefined
            ? `${RESTORE_MARKER} the skill "${skillName}" was loaded earlier in this session (before compaction). Reload that skill first (via the skill tool) to restore its context, then continue the work with that skill's instructions in mind.\n\n`
            : `${RESTORE_MARKER} if a skill was loaded earlier in this session (before compaction), reload that same skill first (via the skill tool) to restore its context, then continue the work with that skill's instructions in mind.\n\n`

        const originalText = part.text

        // 保留 overflow 前缀（以 "The previous request exceeded" 开头的
        // media attachments 说明），只在 "Continue if you have..." 部分前插入
        const continueMarker = "Continue if you have"
        const continueIdx = originalText.startsWith(
          "The previous request exceeded",
        )
          ? originalText.indexOf(continueMarker)
          : -1

        if (continueIdx > 0) {
          const overflowPrefix = originalText.slice(0, continueIdx)
          const continuePart = originalText.slice(continueIdx)
          part.text = overflowPrefix + restorePrefix + continuePart
        } else {
          part.text = restorePrefix + originalText
        }
      }
    },
  }

  return hooks
}) satisfies Plugin
