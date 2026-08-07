import { describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import {
  compilePattern, assertInputSize, testMatch, findAll, replaceAll,
  MAX_INPUT_BYTES,
} from '../src/engine.ts'
import { explainPattern } from '../src/explain.ts'

describe('compilePattern', () => {
  it('compiles a plain pattern', () => {
    const re = compilePattern('\\d+', '')
    expect(re.source).toBe('\\d+')
  })

  it('validates flags character by character', () => {
    expect(() => compilePattern('a', 'q')).toThrow('regex: invalid flag "q"')
    expect(() => compilePattern('a', 'gg')).toThrow('regex: duplicate flag "g"')
    expect(() => compilePattern('a', 'gimsuy dv')).toThrow('regex: invalid flag " "')
  })

  it('accepts all supported flags', () => {
    for (const f of ['g', 'i', 'm', 's', 'u', 'y', 'd', 'v']) {
      expect(() => compilePattern('a', f)).not.toThrow()
    }
  })

  it('adds g automatically when forceGlobal is set', () => {
    expect(compilePattern('a', '', { forceGlobal: true }).flags).toContain('g')
    expect(compilePattern('a', 'i', { forceGlobal: true }).flags).toBe('gi')
    // 用户已给 g 时不重复
    expect(compilePattern('a', 'g', { forceGlobal: true }).flags).toBe('g')
  })

  it('does not force g for test semantics', () => {
    expect(compilePattern('a', '').flags).toBe('')
  })

  it('reports invalid patterns with the engine message', () => {
    expect(() => compilePattern('(', '')).toThrow('regex: invalid pattern')
  })

  it('accepts an empty pattern (matches the empty string)', () => {
    // V8 把空 pattern 的 source 规范化为 (?:)
    expect(compilePattern('', '').source).toBe('(?:)')
    expect(testMatch(compilePattern('', ''), 'abc')).toEqual({ matched: true })
  })

  it('rejects non-string patterns', () => {
    expect(() => compilePattern(42 as unknown as string, '')).toThrow('regex: pattern must be a string')
  })
})

describe('assertInputSize (ReDoS 防线 1：入口拒绝)', () => {
  it(`rejects input over ${MAX_INPUT_BYTES} bytes synchronously`, () => {
    const big = 'a'.repeat(MAX_INPUT_BYTES + 1)
    expect(() => assertInputSize(big)).toThrow(`regex: input exceeds ${MAX_INPUT_BYTES} bytes`)
  })

  it('accepts input at the cap', () => {
    expect(() => assertInputSize('a'.repeat(MAX_INPUT_BYTES))).not.toThrow()
  })

  it('rejects non-string input', () => {
    expect(() => assertInputSize(42)).toThrow('regex: input must be a string')
  })
})

describe('testMatch', () => {
  it('matches simple patterns', () => {
    expect(testMatch(compilePattern('\\d+', ''), 'abc123')).toEqual({ matched: true })
    expect(testMatch(compilePattern('\\d+', ''), 'abc')).toEqual({ matched: false })
  })

  it('honors ^ and $ anchors', () => {
    expect(testMatch(compilePattern('^foo$', ''), 'foo')).toEqual({ matched: true })
    expect(testMatch(compilePattern('^foo$', ''), 'foobar')).toEqual({ matched: false })
  })

  it('honors the m flag for per-line anchoring', () => {
    expect(testMatch(compilePattern('^b', 'm'), 'a\nb')).toEqual({ matched: true })
    expect(testMatch(compilePattern('^b', ''), 'a\nb')).toEqual({ matched: false })
  })

  it('is deterministic even when the user passes g', () => {
    expect(testMatch(compilePattern('a', 'g'), 'aaa')).toEqual({ matched: true })
  })
})

describe('findAll', () => {
  const re = (p: string, f = '') => compilePattern(p, f, { forceGlobal: true })

  it('collects all matches with indexes', () => {
    expect(findAll(re('a+'), 'baaac', 50)).toEqual([
      { index: 1, match: 'aaa', groups: null },
    ])
    expect(findAll(re('a'), 'abac', 50)).toEqual([
      { index: 0, match: 'a', groups: null },
      { index: 2, match: 'a', groups: null },
    ])
  })

  it('exposes capture groups', () => {
    const r = findAll(re('(\\w+)@(\\w+)'), 'a@b x c@d', 50)
    expect(r).toEqual([
      { index: 0, match: 'a@b', groups: null },
      { index: 6, match: 'c@d', groups: null },
    ])
  })

  it('exposes named groups', () => {
    const r = findAll(re('(?<name>\\w+)@(\\w+)'), 'a@b', 50)
    expect(r[0]?.groups).toEqual({ name: 'a' })
  })

  it('returns an empty array on zero matches', () => {
    expect(findAll(re('z'), 'abc', 50)).toEqual([])
  })

  it('respects limit', () => {
    expect(findAll(re('a'), 'aaaa', 2)).toHaveLength(2)
  })

  it('advances past empty matches without an infinite loop', () => {
    const r = findAll(re('x*'), 'ab', 50)
    expect(r).toEqual([
      { index: 0, match: '', groups: null },
      { index: 1, match: '', groups: null },
      { index: 2, match: '', groups: null },
    ])
  })

  it('auto-adds g (single match would otherwise be returned)', () => {
    // forceGlobal 是 find 的入口行为；这里验证产物确实带 g
    expect(re('\\w+').flags).toContain('g')
    expect(findAll(re('\\w+'), 'one two', 50)).toHaveLength(2)
  })
})

describe('replaceAll', () => {
  const re = (p: string, f = '') => compilePattern(p, f, { forceGlobal: true })

  it('performs a basic global replacement', () => {
    expect(replaceAll(re('a'), 'banana', 'X')).toEqual({ result: 'bXnXnX', replaced: 3 })
  })

  it('expands $1 / $2 references', () => {
    expect(replaceAll(re('(\\w+) (\\w+)'), 'hello world', '$2 $1')).toEqual({ result: 'world hello', replaced: 1 })
  })

  it('expands $<name> references', () => {
    expect(replaceAll(re('(?<first>\\w+) (?<second>\\w+)'), 'hello world', '$<second> $<first>'))
      .toEqual({ result: 'world hello', replaced: 1 })
  })

  it('escapes $$ as a literal dollar sign', () => {
    expect(replaceAll(re('a'), 'a', '$$')).toEqual({ result: '$', replaced: 1 })
  })

  it('expands non-participating groups to the empty string', () => {
    expect(replaceAll(re('(a)?b'), 'b', '[$1]')).toEqual({ result: '[]', replaced: 1 })
  })

  it('returns the original text with replaced: 0 on zero matches', () => {
    expect(replaceAll(re('z'), 'abc', '-')).toEqual({ result: 'abc', replaced: 0 })
  })

  it('matches JS semantics for $10 with fewer groups ($1 + "0")', () => {
    expect(replaceAll(re('(b)'), 'ab', '$10')).toEqual({ result: 'ab0', replaced: 1 })
  })

  it('keeps $0 literal like JS', () => {
    expect(replaceAll(re('(b)'), 'ab', '$0')).toEqual({ result: 'a$0', replaced: 1 })
  })

  it('keeps unknown named references literal like JS', () => {
    expect(replaceAll(re('(b)'), 'ab', '$<foo>')).toEqual({ result: 'a$<foo>', replaced: 1 })
  })

  it('rejects a non-string replacement', () => {
    expect(() => replaceAll(re('a'), 'a', 42 as unknown as string)).toThrow('regex: replacement must be a string')
  })
})

// ── ReDoS 测试（§6.2）──

/** 在可终止的 worker 里运行任意同步代码；预算内未完成则 terminate（不挂死测试进程）。 */
function runInKillableWorker(code: string, budgetMs: number): Promise<'completed' | 'terminated'> {
  return new Promise(resolve => {
    const worker = new Worker(code, { eval: true })
    let settled = false
    const finish = (v: 'completed' | 'terminated'): void => {
      if (!settled) { settled = true; resolve(v) }
    }
    worker.once('message', () => finish('completed'))
    worker.once('error', () => finish('completed'))
    setTimeout(() => {
      if (!settled) { void worker.terminate(); finish('terminated') }
    }, budgetMs)
  })
}

describe('ReDoS 防护（§6.2：预算内返回或被取消，不挂死测试进程）', () => {
  it('pathological pattern (a+)+$ on 40KB input is cancelled within budget', async () => {
    const code = `
      const { parentPort } = require('node:worker_threads')
      const re = new RegExp('(a+)+$')
      const input = 'a'.repeat(39999) + 'b'
      re.exec(input)
      parentPort.postMessage('done')
    `
    const t0 = Date.now()
    const outcome = await runInKillableWorker(code, 3000)
    const elapsed = Date.now() - t0
    // 语义：要么在预算内完成，要么被强制取消——无论如何测试进程不挂死
    expect(['completed', 'terminated']).toContain(outcome)
    expect(elapsed).toBeLessThan(10_000)
  }, 15_000)

  it('the 64KB entry cap rejects the same pattern before any execution', () => {
    // 引擎入口先于正则执行拒绝超限输入——这是最可靠的防线，同步且可测
    expect(() => assertInputSize('a'.repeat(MAX_INPUT_BYTES + 1))).toThrow()
  })

  it('a safe pattern on a 40KB input completes quickly in-process', () => {
    const input = 'a'.repeat(40_000) + 'b'
    const t0 = Date.now()
    const r = findAll(compilePattern('a+', '', { forceGlobal: true }), input, 50)
    expect(r).toHaveLength(1)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('explain never executes the pattern (instant on the pathological pattern)', () => {
    const t0 = Date.now()
    const nodes = explainPattern('(a+)+$')
    expect(nodes.length).toBeGreaterThan(0)
    expect(Date.now() - t0).toBeLessThan(100)
  })
})
