# Changelog

## 0.2.15 - 2026-09-19

- 修复 Codex 预设与新版 `@deepseek-ai/dsh-persona` 的配置字段兼容性，使用 `prefix`。
- 自动迁移未修改过的旧 `text` 预设，并保留用户已经修改的预设。
- 记录最低宿主约束：`@deepseek-ai/dsh-persona >=0.1.3-alpha.2`。
- 补充旧预设迁移和用户修改保护的安装器回归测试。
- 固定 Corepack 使用的 pnpm 版本，并锁定兼容的本地压缩工具依赖，保证安装和发布流程可重复。
- 修正当前 DSH 客户端 overlay slot 的类型声明。
