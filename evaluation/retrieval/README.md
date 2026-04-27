# Retrieval Evaluation

本目录用于本地检索质量评测。

真实评测集应保存为 `baseline.local.jsonl`，不要提交真实聊天的 `sessionId`、`localId`、`createTime`、`sortSeq`。

运行示例：

```bash
node scripts/run-retrieval-evaluator.cjs --cases evaluation/retrieval/baseline.local.jsonl --mode hybrid --limit 20
```

如需在评测前构建语义向量索引：

```bash
node scripts/run-retrieval-evaluator.cjs --prepare-vector-index
```

JSONL 每行一个用例，字段见 `baseline.example.jsonl`。
