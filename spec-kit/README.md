# Spec Kit

`spec-kit` 是本项目的 phase 闭环机制。每个 phase 必须按顺序通过以下 gate：

1. `plan`
2. `review`
3. `execute`
4. `qa`
5. `acceptance`

不允许跳 gate，也不允许在上一个 gate 未通过时推进下一个。

## Commands

```bash
# 查看所有 phase 状态
node scripts/spec-kit.mjs status

# 自动给出当前 phase 的下一 gate 和行动清单
node scripts/spec-kit.mjs autoplan

# 标记 gate 完成（带证据）
node scripts/spec-kit.mjs gate --id P1 --name qa --evidence "curl + UI walkthrough passed"

# 关闭 phase（要求所有 gate 已完成）
node scripts/spec-kit.mjs close --id P1

# 创建新 phase（基于模板）
node scripts/spec-kit.mjs create --id P4 --title "Something"
```

## Files

1. `spec-kit/phases.json`：phase 注册表与 gate 状态
2. `spec-kit/phases/*.md`：每个 phase 的规格与证据日志
3. `spec-kit/templates/phase-spec.template.md`：新 phase 模板

## SOP Mapping

`docs/sop.md` 的闭环要求 `plan → review → implement → real simulated QA → acceptance`
在 `spec-kit` 中映射为：

1. `plan`
2. `review`
3. `execute`
4. `qa`
5. `acceptance`
