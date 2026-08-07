# dsh-tool-regex

DSH 正则工具插件 —— 测试匹配、提取捕获组、安全替换、**静态解释正则含义（不执行任何代码）**。零依赖、纯函数。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 动机

模型经常需要验证用户给的 pattern、从日志/文本中提取字段、做文本替换。"心算"正则结果错误率极高，且无法给用户展示可验证的过程。现有替代是起 `bash` 进程跑 `node -e` 或 python——进程开销 + 模型现写脚本的正确性风险。内置 `grep` 只能做**文件域**搜索，无法对任意文本测试/提取/替换/解释。

本插件提供确定性正则工具，其中 `explain` 是差异化能力：静态解析 pattern 结构并给出人读解释，**不执行匹配**，天然免疫 ReDoS。

## 安全模型（ReDoS 三层防线）

JS 正则的灾难性回溯是真实威胁（如 `(a+)+$` 配合超长输入）。防线：

1. **输入长度上限**：64,000 字节（UTF-8）——正则复杂度指数级时，长度上限是唯一可靠防线；超限在入口直接拒绝，不进入回溯
2. **执行时间预算**：`timeoutMs: 1000`——dsh 工具管道超时取消，模型回合不会卡死
3. **explain 零执行**：只做静态 tokenizer，不构造 `RegExp` 实例，任何 pattern 都即时返回

> ⚠️ 工具描述与 README 均明确警告模型：**不要对不可信的大输入使用无锚点的嵌套量词 pattern**（如 `(a+)+`、`(.*)*`）。

其余边界：无效 pattern 捕获 `SyntaxError` 报错（含位置信息）；无效/重复 flag 逐字符校验；`replace` 使用 `String.replace` **字符串替换路径**（JS 原生 `$`-语义，无 `new Function`、无 eval）。

## 工具声明

注册 `regex` 工具（`@deepseek-ai/dsh-tool-regex`，row id `tool-regex`），统一输出 JSON 文本字符串。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | ✅ | `test` / `find` / `replace` / `explain` |
| `pattern` | string | ✅ | 正则（JavaScript 语法，**不含**外围 `/`） |
| `input` | string | | 待匹配文本（test/find/replace 必需） |
| `flags` | string | | 如 `"gi"`；支持 `g i m s u y d v`，需唯一且合法 |
| `replacement` | string | | replace 的替换文本，支持 `$1`/`$2`/`$<name>`/`$$` |
| `limit` | integer | | find 最大报告匹配数，默认 50 |

## Actions

| action | 功能 | 输出示例 |
|---|---|---|
| `test` | 判断是否匹配（整串语义由模型自行用 `^...$` 表达） | `{"matched":true}` |
| `find` | 全部匹配：index / 完整匹配 / 命名与编号捕获组（**无 `g` 自动补 `g`**） | `[{"index":0,"match":"a@b","groups":{"name":"a"}}]` |
| `replace` | 全局安全替换（`$1`/`$<name>`/`$$`），返回结果与替换次数 | `{"result":"world hello","replaced":1}` |
| `explain` | 静态解析 pattern → 人读节点序列（不执行匹配） | `[{"kind":"escape","text":"\\d","meaning":"A digit [0-9]"}]` |

## 示例

```
regex { action: "find", pattern: "(\\w+)@(\\w+)", input: "a@b x c@d" }
  → [{"index":0,"match":"a@b","groups":null},{"index":6,"match":"c@d","groups":null}]

regex { action: "replace", pattern: "(\\w+) (\\w+)", input: "hello world", replacement: "$2 $1" }
  → {"result":"world hello","replaced":1}

regex { action: "explain", pattern: "\\d{4}-\\d{2}" }
  → [{"kind":"escape","text":"\\d","meaning":"A digit [0-9]"},{"kind":"quantifier","text":"{4}",...},...]
```

## 边界行为

| 情况 | 处理 |
|---|---|
| 无效 pattern | `regex: invalid pattern: <SyntaxError 信息（含位置）>`，不崩溃 |
| 无效 flag / 重复 flag | `regex: invalid flag "q"` / `regex: duplicate flag "g"` |
| 空 pattern | 合法（匹配空串） |
| 命名组 | find 输出 `groups: {name: value}`；replace 支持 `$<name>` |
| 零匹配 | find 返回 `[]`；replace 返回原文本 + `replaced: 0` |
| 输入超 64KB | `regex: input exceeds 64000 bytes`（入口拒绝） |
| `$` 引用 | 走 JS 原生字符串替换路径：`$$`→`$`、`$n`→组（未参与→空串）、`$<name>`→命名组、未知引用字面保留（`$0`/`$<foo>` 与 V8 一致） |

## 接入方式

```bash
dsh plugin --profile web add "C:/path/to/dsh-tool-regex"
dsh plugin --profile headless add "C:/path/to/dsh-tool-regex"
dsh --profile web --dump-config | grep tool-regex
```

## 测试

```bash
node <monorepo>/node_modules/vitest/vitest.mjs run tests
```

- `engine.spec.ts`：test/find/replace 全分支 + flags/pattern 错误 + 64KB 上限 + **ReDoS worker 用例**（病理 pattern 在 3s 预算内被取消，不挂死测试进程）
- `explain.spec.ts`：字面量/字符类/分组/量词/转义/锚点/交替 + 未闭合报错
- `register.spec.ts`：注册契约（AUDIT-CROSS-02 风格）

## 许可

MIT
