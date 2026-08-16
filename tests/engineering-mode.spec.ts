import { describe, expect, it } from 'vitest'
import {
  ENGINEERING_PRESET_ID,
  extractAssistantText,
  mergeRows,
  normalizeTaskList,
  optimizeTaskList,
  shouldMerge,
  titleSimilarity,
} from '../plugins/dsh-client-ui-engineering-mode/lib/index.js'

describe('engineering mode pure helpers', () => {
  it('extracts text blocks from assistant messages after the requested seq', () => {
    const history = [
      { event: { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'ignored' }] } } } },
      { event: { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: ' hello ' }] } } } },
      { event: { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'tool_use', name: 'pwsh' }, { type: 'text', text: ' world ' }] } } } },
    ]
    expect(extractAssistantText(history, { afterSeq: 1 })).toBe('hello\n\nworld')
    expect(extractAssistantText(history, { afterSeq: 3 })).toBe('')
  })

  it('normalizes a task JSON array embedded in markdown prose', () => {
    const text = '好的，任务如下：\n```json\n[{"title":" 任务一 ","detail":"说明一","dependsOn":[]},{"title":"任务二","detail":"说明二"}]\n```'
    expect(normalizeTaskList(text)).toEqual([
      { title: '任务一', detail: '说明一', dependsOn: [] },
      { title: '任务二', detail: '说明二', dependsOn: [] },
    ])
  })

  it('rejects malformed and non-array task splits', () => {
    expect(normalizeTaskList('not json [{"title":"missing detail"}]')).toEqual([])
    expect(normalizeTaskList('{"title":"object"}')).toEqual([])
    expect(normalizeTaskList('')).toEqual([])
  })

  it('folds trivially small adjacent tasks and remaps dependency edges', () => {
    const rows = [
      { title: '实现登录页', detail: '创建登录页面并接入登录接口，产出可运行的登录页。', dependsOn: [] },
      { title: '补样式', detail: '微调样式', dependsOn: [0] },
      { title: '实现首页', detail: '实现首页布局与数据加载，产出可运行的首页。', dependsOn: [1] },
    ]
    const optimized = optimizeTaskList(rows)
    expect(optimized).toHaveLength(2)
    expect(optimized[0].title).toContain('登录')
    expect(optimized[0].detail).toContain('微调样式')
    expect(optimized[1].dependsOn).toEqual([0])
  })

  it('deduplicates identical tasks and merges near-identical titles', () => {
    const rows = [
      { title: '实现登录接口', detail: '编写登录接口、校验逻辑和单元测试。', dependsOn: [] },
      { title: '实现登录接口', detail: '编写登录接口、校验逻辑和单元测试。', dependsOn: [] },
      { title: '登录接口联调', detail: '联调登录接口并修复发现的问题，确认接口可用。', dependsOn: [0] },
    ]
    const optimized = optimizeTaskList(rows)
    expect(optimized).toHaveLength(1)
    expect(optimized[0].detail).toContain('联调')
  })

  it('keeps meaningfully distinct large tasks separate', () => {
    const rows = [
      { title: '实现用户注册', detail: '实现用户注册页面、注册接口调用和表单校验，产出可运行的注册流程。', dependsOn: [] },
      { title: '实现权限系统', detail: '实现角色权限模型、接口鉴权和菜单控制，产出可运行的权限系统。', dependsOn: [] },
    ]
    expect(optimizeTaskList(rows)).toHaveLength(2)
  })

  it('exposes merge and similarity primitives for targeted tests', () => {
    expect(titleSimilarity('实现登录页', '登录页联调')).toBeGreaterThan(0.3)
    expect(shouldMerge(
      { title: '实现登录页', detail: '创建登录页面并接入登录接口。' },
      { title: '微调样式', detail: '微调' },
    )).toBe(true)
    expect(mergeRows(
      { title: '实现登录页', detail: '创建登录页面。', dependsOn: [] },
      { title: '微调样式', detail: '微调', dependsOn: [0] },
    )).toEqual({ title: '实现登录页 + 微调样式', detail: '创建登录页面。\n微调', dependsOn: [0] })
  })

  it('pins the engineering run to the minimal PowerShell preset', () => {
    expect(ENGINEERING_PRESET_ID).toBe('minimal-powershell')
  })
})
