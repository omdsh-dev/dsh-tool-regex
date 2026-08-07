/**
 * 正则执行引擎 —— test / find / replace。零依赖，纯函数。
 *
 * 安全设计（ReDoS 三层防线）：
 * 1. 输入长度上限 MAX_INPUT_BYTES = 64,000 字节（正则复杂度指数级时，长度上限是唯一可靠防线）；
 *    超限在入口直接拒绝（不进入回溯）。
 * 2. timeoutMs 1000（由 dsh 工具管道在超时后取消，见工具声明）。
 * 3. 同步执行 + 大输入拒绝：pattern 编译用 new RegExp()（同步、快）。
 *
 * flags 校验：逐字符校验（g i m s u y d v），重复 flag 报错；find/replace 自动补 'g'。
 *
 * replace 实现说明（与设计文档的差异，见 README）：
 * 采用 String.prototype.replace 的**字符串替换路径**（JS 原生 $-语义：$$、$1..$n、
 * $<name>、$&、$`、$'，$10 前缀回退，$<unknown> 字面保留），并独立 exec 循环计数
 * 替换次数——函数回调路径不会二次展开 $ 引用，手动展开又与 V8 语义存在偏差，故不用。
 */

export const MAX_INPUT_BYTES = 64_000

const VALID_FLAGS = 'dgimsuyv'

export interface FindMatch {
  /** 匹配起始下标（0-based，字符索引）。 */
  index: number
  /** 完整匹配文本。 */
  match: string
  /** 命名捕获组（无命名组时为 null；未参与匹配的组为 undefined）。 */
  groups: Record<string, string | undefined> | null
}

export interface ReplaceResult {
  result: string
  replaced: number
}

export interface CompileOptions {
  /** 是否强制补 'g'（find/replace 需要；test 不补，避免 stateful lastIndex 干扰）。 */
  forceGlobal?: boolean
}

/** 编译 pattern + flags；flags 逐字符校验，重复/非法 flag 报错。 */
export function compilePattern(pattern: unknown, flags: unknown, options?: CompileOptions): RegExp {
  if (typeof pattern !== 'string') {
    throw new Error('regex: pattern must be a string')
  }
  const flagStr = flags === undefined || flags === null ? '' : String(flags)
  const seen = new Set<string>()
  for (const ch of flagStr) {
    if (seen.has(ch)) throw new Error(`regex: duplicate flag "${ch}"`)
    if (!VALID_FLAGS.includes(ch)) throw new Error(`regex: invalid flag "${ch}"`)
    seen.add(ch)
  }
  const forceGlobal = options?.forceGlobal === true
  const effective = forceGlobal && !flagStr.includes('g') ? flagStr + 'g' : flagStr
  try {
    return new RegExp(pattern, effective)
  } catch (error) {
    // SyntaxError message 通常含 "at position N"
    throw new Error(`regex: invalid pattern: ${String((error as Error).message)}`)
  }
}

/** 输入大小守卫：超 MAX_INPUT_BYTES 直接拒绝（不截断）。 */
export function assertInputSize(input: unknown): void {
  if (typeof input !== 'string') {
    throw new Error('regex: input must be a string')
  }
  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`regex: input exceeds ${MAX_INPUT_BYTES} bytes`)
  }
}

/** test：判断是否匹配（整串 ^...$ 语义由模型自行用锚点表达）。 */
export function testMatch(re: RegExp, input: string): { matched: boolean } {
  re.lastIndex = 0
  return { matched: re.test(input) }
}

/** find：收集所有匹配 + 捕获组，受 limit 约束（默认 50）。 */
export function findAll(re: RegExp, input: string, limit: number): FindMatch[] {
  const out: FindMatch[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    out.push({
      index: m.index,
      match: m[0],
      groups: m.groups ? { ...m.groups } : null,
    })
    if (out.length >= limit) break
    if (m[0].length === 0) re.lastIndex++ // 空匹配推进，防死循环
  }
  return out
}

/** replace：全局替换（编译时已强制 'g'），返回结果文本与替换次数。 */
export function replaceAll(re: RegExp, input: string, replacement: unknown): ReplaceResult {
  if (typeof replacement !== 'string') {
    throw new Error('regex: replacement must be a string')
  }
  // 计数 pass：与 replace 相同的遍历语义（含空匹配推进规则）
  let replaced = 0
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    replaced++
    if (m[0].length === 0) re.lastIndex++
  }
  // 执行 pass：字符串替换路径（JS 原生 $-语义，回调路径不会二次展开）
  re.lastIndex = 0
  const result = input.replace(re, replacement)
  return { result, replaced }
}
