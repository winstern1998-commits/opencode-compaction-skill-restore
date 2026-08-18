# opencode-compaction-skill-restore

An OpenCode **server-side** plugin that rewrites the synthetic "continue" message inserted after auto-compaction, reminding the model to reload any skill that was loaded earlier in the session before proceeding.

## What It Does

When opencode's context window overflows, it performs **auto compaction**: the conversation is summarized, old messages are replaced with a compaction summary, and a synthetic user message is appended to let the model continue:

> Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.

The problem: if a **skill** was loaded before compaction, its instructions (SKILL.md content, file list, routing rules) are lost from the compacted context. The model continues working without the skill's guidance.

This plugin intercepts that synthetic message via `experimental.chat.messages.transform` and prepends a skill-restore instruction, telling the model to reload the same skill first. If the plugin tracked which skill was loaded (via `tool.execute.after`), it names it explicitly; otherwise it uses a generic fallback.

### Rewritten message (with tracked skill name)

> Before continuing: the skill "my-skill" was loaded earlier in this session (before compaction). Reload that skill first (via the skill tool) to restore its context, then continue the work with that skill's instructions in mind.
>
> Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.

### Rewritten message (no skill tracked, fallback)

> Before continuing: if a skill was loaded earlier in this session (before compaction), reload that same skill first (via the skill tool) to restore its context, then continue the work with that skill's instructions in mind.
>
> Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.

## How It Works

Two plugin hooks are used:

| Hook | Purpose |
|---|---|
| `tool.execute.after` | When the model successfully calls the `skill` tool, records the skill name keyed by `sessionID`. Uses `after` (not `before`) so the skill is only tracked after the tool executes successfully — if the user denies the skill-load permission, no name is recorded. The skill name is read from the tool's returned `metadata.name` (see opencode source `tool/skill.ts`). |
| `experimental.chat.messages.transform` | Called before each LLM turn with the full `messages` array. The plugin finds the synthetic compaction-continue part (`part.synthetic === true && part.metadata?.compaction_continue === true`) in the **last user message** and rewrites `part.text` in-place. Only the last user message is processed to avoid interfering with the compaction LLM call (which receives historical messages and may contain older synthetic continue parts). |

### Overflow prefix preservation

If compaction was triggered by oversized media attachments (overflow), the synthetic message has an additional prefix explaining that attachments were removed:

> The previous request exceeded the provider's size limit due to large media attachments...

The plugin preserves this prefix intact and only inserts the skill-restore instruction before the "Continue if you have..." portion.

### Idempotency

The `msgs` array is reconstructed from the database on each loop iteration, so `part.text` modifications are non-persistent (they only affect the current LLM call). An idempotency guard (`part.text.includes(RESTORE_MARKER)`, where `RESTORE_MARKER` is a module-level constant shared with the restore prefix) prevents double-prepending in any edge case where the same Part object might be reused.

## Install

This is a **server-side plugin** (not a TUI plugin). Add the path to `src/index.ts` in your opencode config's `plugin` array:

```jsonc
// .opencode/opencode.json or ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "/absolute/path/to/opencode-compaction-skill-restore/src/index.ts"
  ]
}
```

Or use a relative path (relative to the `.opencode/` directory):

```jsonc
{
  "plugin": [
    "../opencode-compaction-skill-restore/src/index.ts"
  ]
}
```

Restart opencode after changing plugin config.

### Local development

```bash
cd opencode-compaction-skill-restore
bun install          # install dependencies
bun run typecheck    # tsc --noEmit
```

## Caveats

- **Experimental hooks**: `experimental.chat.messages.transform` and the `compaction_continue` metadata marker are not stable plugin contracts. They may change or be removed in future opencode versions. The comment in opencode's `compaction.ts` explicitly states: *"This is not a stable plugin contract and may change or disappear."*
- **Skill tracking is in-memory**: The `sessionID → skillName` map lives in the plugin process memory. If the opencode server restarts mid-session, the tracking is lost and the fallback (generic) text is used until the model loads a skill again.
- **Only tracks the `skill` tool**: If a skill is loaded through a different mechanism (e.g., manually pasting skill content), the plugin won't track it.
- **Last skill wins**: If multiple skills are loaded in a session, only the most recently loaded one is tracked.
- **No cleanup of tracking map**: The `sessionID → skillName` map is never pruned. In long-running opencode server processes with many sessions, this map may accumulate stale entries. The memory footprint per entry is small (two strings), so this is an accepted trade-off rather than a bug, but it means the map grows unbounded over the process lifetime.

## Compatibility

Tested against `@opencode-ai/plugin` and `@opencode-ai/sdk` version `1.17.13`.
