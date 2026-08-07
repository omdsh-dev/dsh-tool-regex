/**
 * DSH 正则工具插件。
 *
 * 注册 `regex` 工具：测试匹配、提取捕获组、安全替换、静态解释正则（不执行代码）。
 * 接入方式：在 cordis.yml 追加：
 *   - id: tool-regex
 *     name: '@deepseek-ai/dsh-tool-regex'
 *
 * 安全边界：零依赖（JS 内置 RegExp）；纯函数；输入 64KB 上限 + timeoutMs 1000
 * 三层 ReDoS 防线（见 engine.ts）；explain 不构造 RegExp 实例，天然免疫 ReDoS。
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { compilePattern, assertInputSize, testMatch, findAll, replaceAll } from './engine.ts'
import { explainPattern } from './explain.ts'

export const name = '@deepseek-ai/dsh-tool-regex'
export const inject = ['tools']

interface RegexArgs {
  action: string
  pattern?: unknown
  input?: unknown
  flags?: unknown
  replacement?: unknown
  limit?: unknown
}

const DEFAULT_LIMIT = 50

function normalizeLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_LIMIT
  }
  return Math.floor(limit)
}

function runAction(args: RegexArgs): string {
  const { action } = args
  const flags = typeof args.flags === 'string' && args.flags !== '' ? args.flags : undefined
  const limit = normalizeLimit(args.limit)

  switch (action) {
    case 'test': {
      assertInputSize(args.input)
      const re = compilePattern(args.pattern, flags)
      return JSON.stringify(testMatch(re, args.input as string))
    }
    case 'find': {
      assertInputSize(args.input)
      // 无 g 自动补 g：否则只能拿到第一个匹配，语义意外（文档明确说明）
      const re = compilePattern(args.pattern, flags, { forceGlobal: true })
      return JSON.stringify(findAll(re, args.input as string, limit))
    }
    case 'replace': {
      assertInputSize(args.input)
      const re = compilePattern(args.pattern, flags, { forceGlobal: true })
      return JSON.stringify(replaceAll(re, args.input as string, args.replacement))
    }
    case 'explain': {
      // 静态解析：不构造 RegExp、不执行匹配
      return JSON.stringify(explainPattern(args.pattern))
    }
    default:
      throw new Error(`regex: unknown action "${action}"`)
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'regex',
    description:
      'Regular expression utilities over text (JavaScript syntax; pattern without surrounding slashes). ' +
      'Actions: test (does input match), find (all matches with index and capture groups; ' +
      'the g flag is added automatically), replace (global safe replacement with $1/$<name>/$$ ' +
      'references), explain (static human-readable breakdown of the pattern; never executes it). ' +
      'Do not use unanchored nested quantifiers (e.g. (a+)+) on large untrusted input: ReDoS risk; ' +
      'inputs over 64KB are rejected.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['test', 'find', 'replace', 'explain'],
        description: 'Operation to perform.',
      },
      pattern: {
        type: 'string',
        required: true,
        description: 'Regular expression pattern (JavaScript syntax; do not include surrounding slashes).',
      },
      input: {
        type: 'string',
        description: 'Text to match against (required for test/find/replace).',
      },
      flags: {
        type: 'string',
        description: 'Flag characters, e.g. "gi". Supported: g i m s u y d v. Must be unique and valid; unknown flags error out.',
      },
      replacement: {
        type: 'string',
        description: 'Replacement text for replace; supports $1, $2, $<name> references and $$ for a literal dollar sign.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum matches to report (find), default 50. Prevents unbounded output.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: args => Promise.resolve(runAction(args as RegexArgs)),
    timeoutMs: 1000,
  }))
}
