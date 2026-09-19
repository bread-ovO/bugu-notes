# 事件学习真实模型验收记录 · 2026-09-19

仅使用隔离合成内容，没有读取真实消息、会话历史或凭据文件。CLI 使用用户已许可的登录，关闭工具调用。完整基线与后续复测分别保存，不能合并成一次全量通过。

| 运行 | 结果 | 范围 |
| --- | --- | --- |
| Codex 旧提示完整基线 | 原始 347/360；标注修正后 349/360 | 200 个 family，含时间/候选排序相关变体 |
| Codex 新提示定向复测 | 22/22 | 14 个 family；失败项、顺序变体及分类对照；不是新的全量测试 |
| Claude CLI 冒烟 | 连续 3 次 MODEL_TIMEOUT，停止 | 计划 9 条，未完成，不计算模型正确率 |
| Responses / Chat Completions | 未运行真实评测 | 本次没有配置评测凭据；不读取应用密钥来替代授权 |

## 基线分项

| 指标 | 结果 | 解释 |
| --- | --- | --- |
| 事件分类 | 79/80，98.75% | 独立语义样本的 Wilson 95% 区间约 93.25%–99.78% |
| 双边关联 | 120/120 | 仅 40 个独立 family，0/2/48 小时变体；family Wilson 区间约 91.24%–100% |
| 高置信推荐精确率 | 128/128，100% | 指通过引用/目标/置信门槛后实际给出的正向推荐；不等同生产可靠性 |
| 可推荐场景覆盖 | 128/138，92.75% | 10 条低置信输出被拒绝；未降低 0.9 门槛 |
| 应当弃答 | 22/22 | 20 条无行动场景、2 条无邮件目标场景 |
| 推荐 family 全变体一致通过 | 73/80 | 同一语义的正序和逆序不能计成两个独立证据 |
| 单次模型调用耗时 | 中位 32.47 秒，p95 36.68 秒 | 本机 CLI、4 并发；不是弹窗渲染延迟；用量及成本未暴露，记为未知 |

## 失败处置

- `classify-unknown-1`：“收到，谢谢。”被误当成需要回复的新事件。提示增加“需要做的工作”与“消息语言形式”的区分，已在相邻确认/回复案例中复测。
- 两条 `recommend-reply-3`：“回复邮件”只有飞书消息候选。模型拒绝推荐正确，旧期望错误。修正两条期望为弃答；原始文件中的失败不覆盖，不改变模型原始输出。
- 10 条 `NEXT_LOW_CONFIDENCE`：文档、开发、回复等候选不确定。保留弃答门槛；新提示复测失败项及正反顺序均通过，不能认定波动已经消失。
- 基线运行时尚未记录验证异常的原始响应，因此这 10 条仅有错误码。新评测器在本地验证之前记录合成原始结构化响应，复测保留完整结果。没有补造历史响应。

## 文件与复现

- `codex-baseline-results.json` / `codex-baseline-report.json`：未经覆盖的完整基线。
- `codex-targeted-retest-results.json` / `codex-targeted-retest-report.json`：修复后定向复测与提示/测试集 SHA256。
- `claude-smoke-results.json` / `claude-smoke-report.json`：超时证据。
- `metrics.json`：分项计数、基线代码引用和限定范围。
- `soak-600s.json`：10 分钟隔离 Electron 资源样本；不是 24 小时实机报告。

```sh
node scripts/eval-next-action.mjs --live --provider codex-cli --limit 360 --concurrency 4 --output test-results/next-action-live-full-new
node scripts/eval-next-action.mjs --live --provider codex-cli --ids classify-unknown-1,recommend-reply-3-normal --output test-results/next-action-targeted-new
BUGU_NEXT_SOAK_SECONDS=600 pnpm exec playwright test tests/desktop/next-soak.spec.ts
```

当前命令使用新提示和修正标注。基线提示/测试集对应 `470d2f4`。评测脚本仍按 99% 综合命中阈值返回非零，基线未通过此更严格阈值；不能把退出码隐藏后称为全通过。功能方案的分类、推荐、覆盖、弃答和精确跳转指标是不同分母，详见完整方案；本报告不宣称完成真实桌面跳转验收、个性化收益对照或试用者价值验证。
