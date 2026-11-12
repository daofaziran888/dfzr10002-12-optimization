/**
 * LinkageStore 并发与缓存规则测试（Node 环境，mock fetch 控制响应时序）。
 * 运行：node tests/run-linkage-tests.mjs
 *
 * 覆盖：
 * 1. 连续筛选变化经防抖只合并成一次取数，上屏的是最后一次选择；
 * 2. 并发响应里旧令牌结果被丢弃，不能覆盖新结果；
 * 3. 旧代次（stale）响应以最新代次为准被丢弃，保留上一代上屏数据；
 * 4. 手动刷新独立于防抖，携带 force 并推进代次；
 * 5. 每轮筛选都登记并关闭轮次，导出任务记录当前图表快照。
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = mkdtempSync(join(tmpdir(), 'linkage-store-'))
const entry = join(outDir, 'entry.mjs')
writeFileSync(entry, `export { LinkageStore } from ${JSON.stringify(join(here, '..', 'src', 'stores', 'linkage.ts'))};
export { __setMockHandler } from ${JSON.stringify(join(here, 'mock-client.ts'))};
`)

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  define: { 'import.meta.env.VITE_API_BASE': '""' },
  plugins: [
    {
      name: 'mock-api-client',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^@\/api\/client$/ }, () => ({
          path: join(here, 'mock-client.ts'),
        }))
      },
    },
  ],
})
const bundled = join(outDir, 'bundle.mjs')
writeFileSync(bundled, result.outputFiles[0].text)
const { LinkageStore, __setMockHandler } = await import(pathToFileURL(bundled).href)

const overviewBody = {
  filter_options: { 地区: ['全部', '华东', '华南', '华北'] },
  datasets: [
    { dataset_code: 'DATA-0001', generation: 1, cached_snapshots: 0 },
    { dataset_code: 'DATA-0002', generation: 1, cached_snapshots: 0 },
  ],
  charts: [
    {
      chart_id: 1, 图表编号: 'CHAR-0001', 图表名称: '区域销售趋势', 图表类型: '折线图',
      dataset_code: 'DATA-0001', 横轴字段: '统计日期', 纵轴字段: '销售额', 刷新间隔: 30, status: '已启用',
    },
    {
      chart_id: 2, 图表编号: 'CHAR-0002', 图表名称: '区域订单结构', 图表类型: '柱状图',
      dataset_code: 'DATA-0001', 横轴字段: '地区', 纵轴字段: '订单数', 刷新间隔: 60, status: '已启用',
    },
    {
      chart_id: 3, 图表编号: 'CHAR-0003', 图表名称: '客户分群占比', 图表类型: '饼图',
      dataset_code: 'DATA-0002', 横轴字段: '客户分群', 纵轴字段: '客户数', 刷新间隔: 15, status: '已停用',
    },
  ],
  rounds: [],
  export_tasks: [],
  fetch_count: 0,
}

function fetchBody(region, generation, staleDataset) {
  const makeChart = (chartId, datasetCode) => ({
    chart_id: chartId,
    图表编号: `CHAR-000${chartId}`,
    图表名称: '样例',
    dataset_code: datasetCode,
    generation: staleDataset === datasetCode ? generation - 1 : generation,
    expected_generation: null,
    stale: staleDataset === datasetCode,
    filter_hash: `hash-${region}-${generation}`,
    filters: { 地区: region },
    cached: false,
    fetched_at: 'now',
    series: [{ x: region, y: generation * 100 + chartId, x_field: 'x', y_field: 'y' }],
  })
  return {
    filters: { 地区: region },
    filter_hash: `hash-${region}`,
    generations: {
      'DATA-0001': staleDataset === 'DATA-0001' ? generation - 1 : generation,
      'DATA-0002': staleDataset === 'DATA-0002' ? generation - 1 : generation,
    },
    forced: false,
    charts: [makeChart(1, 'DATA-0001'), makeChart(2, 'DATA-0001')],
    fetch_count: 1,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function withStore(route) {
  const calls = []
  __setMockHandler(async (path, init) => {
    const body = init?.body ? JSON.parse(init.body) : {}
    calls.push({ path, method: init?.method ?? 'GET', body })
    return route(path, body, calls)
  })
  const store = new LinkageStore()
  await store.loadOverview()
  return { store, calls }
}

// 用例 1：防抖合并 —— 华东→华南→华北 连续切换，只发一次取数且上屏华北。
async function testDebounceMergesRapidChanges() {
  const { store, calls } = await withStore(async (path, body) => {
    if (path.endsWith('/overview')) return overviewBody
    if (path.endsWith('/rounds')) {
      return {
        round_id: calls.filter((c) => c.path.endsWith('/rounds')).length,
        filters: body.values.filters,
        filter_hash: `h-${body.values.filters.地区}`,
        status: '进行中',
        opened_at: 't',
        closed_at: null,
        generations: {},
      }
    }
    if (path.endsWith('/fetch')) return fetchBody(body.values.filters.地区, 1)
    if (path.includes('/close')) return { ...store.rounds.at(-1), status: '已结束', closed_at: 't' }
    if (path.endsWith('/export-tasks')) return { items: store.exportTasks }
    throw new Error(`未覆盖的路径 ${path}`)
  })

  store.onFilterChange('地区', '华东')
  store.onFilterChange('地区', '华南')
  store.onFilterChange('地区', '华北')
  await sleep(360)

  const fetchCalls = calls.filter((c) => c.path.endsWith('/fetch'))
  assert.equal(fetchCalls.length, 1, '连续切换只能合并成一次取数')
  assert.deepEqual(fetchCalls[0].body.values.filters, { 地区: '华北' })
  assert.deepEqual(store.appliedFilters, { 地区: '华北' }, '只有最后一次选择上屏')
  assert.equal(store.chartData.get(1).series[0].x, '华北')
  console.log('ok testDebounceMergesRapidChanges')
}

// 用例 2：last-wins —— 旧令牌响应晚到时被丢弃，不覆盖新结果。
async function testStaleTokenResponseDropped() {
  let releaseFirst
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  const { store, calls } = await withStore(async (path, body) => {
    if (path.endsWith('/overview')) return overviewBody
    if (path.endsWith('/rounds')) {
      return {
        round_id: calls.filter((c) => c.path.endsWith('/rounds')).length,
        filters: body.values.filters, filter_hash: 'h', status: '进行中',
        opened_at: 't', closed_at: null, generations: {},
      }
    }
    if (path.endsWith('/fetch')) {
      const region = body.values.filters.地区
      if (region === '华东') {
        await gate // 第一轮响应在途挂起
        return fetchBody('华东', 1)
      }
      return fetchBody('华南', 1)
    }
    if (path.includes('/close')) return { ...store.rounds.at(-1), status: '已结束', closed_at: 't' }
    if (path.endsWith('/export-tasks')) return { items: store.exportTasks }
    throw new Error(`未覆盖的路径 ${path}`)
  })

  store.onFilterChange('地区', '华东')
  store.applyNow() // 华东先发出并在途挂起
  await sleep(20)
  store.onFilterChange('地区', '华南')
  await sleep(360) // 华南轮次完成上屏
  releaseFirst()   // 华东旧响应此时才返回
  await sleep(20)

  assert.deepEqual(store.appliedFilters, { 地区: '华南' })
  assert.equal(store.chartData.get(1).series[0].x, '华南', '旧响应不能覆盖新结果')
  assert.ok(store.droppedResponses >= 1, '旧令牌响应应计入丢弃数')
  console.log('ok testStaleTokenResponseDropped')
}

// 用例 3：代次冲突 —— stale 响应按最新代次丢弃，保留上一代上屏数据。
async function testStaleGenerationDropped() {
  const { store } = await withStore(async (path, body) => {
    if (path.endsWith('/overview')) return overviewBody
    if (path.endsWith('/rounds')) {
      return {
        round_id: 1, filters: body.values.filters, filter_hash: 'h', status: '进行中',
        opened_at: 't', closed_at: null, generations: {},
      }
    }
    if (path.endsWith('/fetch')) {
      // 已知代次是 2，后端返回的 DATA-0001 仍是代次 1 且带 stale
      return fetchBody(body.values.filters.地区, 2, 'DATA-0001')
    }
    if (path.includes('/close')) return { round_id: 1, status: '已结束' }
    if (path.endsWith('/export-tasks')) return { items: [] }
    throw new Error(`未覆盖的路径 ${path}`)
  })
  store.knownGenerations = { 'DATA-0001': 2, 'DATA-0002': 2 }
  store.chartData.set(1, { ...fetchBody('旧筛选', 1).charts[0], stale: false })
  store.applyNow()
  await sleep(20)

  const kept = store.chartData.get(1)
  assert.equal(kept.series[0].x, '旧筛选', '旧代次结果应被丢弃，保留上一代上屏数据')
  assert.ok(store.droppedResponses >= 1)
  console.log('ok testStaleGenerationDropped')
}

// 用例 4：手动刷新 —— 立即执行、带 force、代次推进后新结果上屏。
async function testManualRefreshBumpsGeneration() {
  const { store, calls } = await withStore(async (path, body) => {
    if (path.endsWith('/overview')) return overviewBody
    if (path.endsWith('/datasets/refresh')) return { dataset_code: body.values.dataset_code, generation: 2, refreshed_at: 't' }
    if (path.endsWith('/rounds')) {
      return {
        round_id: 1, filters: body.values.filters, filter_hash: 'h', status: '进行中',
        opened_at: 't', closed_at: null, generations: {},
      }
    }
    if (path.endsWith('/fetch')) return fetchBody(body.values.filters.地区, 2)
    if (path.includes('/close')) return { round_id: 1, status: '已结束' }
    if (path.endsWith('/export-tasks')) return { items: [] }
    throw new Error(`未覆盖的路径 ${path}`)
  })

  // 先挂一个防抖，确认手动刷新会取消它而不是等待合并。
  store.onFilterChange('地区', '华东')
  await store.manualRefresh('DATA-0001')
  const refreshCall = calls.find((c) => c.path.endsWith('/datasets/refresh'))
  const forceFetch = calls.find((c) => c.path.endsWith('/fetch'))
  assert.ok(refreshCall, '手动刷新必须调用数据集刷新接口')
  assert.equal(forceFetch.body.values.force, true, '手动刷新取数要带 force 语义')
  assert.equal(store.knownGenerations['DATA-0001'], 2, '本地代次表推进到新代次')
  assert.equal(store.datasets.find((d) => d.dataset_code === 'DATA-0001').generation, 2)
  console.log('ok testManualRefreshBumpsGeneration')
}

// 用例 5：轮次台账与导出任务快照。
async function testRoundAndExportTaskSnapshot() {
  const { store, calls } = await withStore(async (path, body) => {
    if (path.endsWith('/overview')) return overviewBody
    if (path.endsWith('/rounds')) {
      const id = calls.filter((c) => c.path.endsWith('/rounds') && !c.path.includes('close')).length
      return {
        round_id: id, filters: body.values.filters, filter_hash: 'h', status: '进行中',
        opened_at: 't', closed_at: null, generations: {},
      }
    }
    if (path.endsWith('/fetch')) return fetchBody(body.values.filters.地区, 1)
    if (path.includes('/close')) return { ...store.rounds.at(-1), status: '已结束', closed_at: 't' }
    if (path.endsWith('/export-tasks')) {
      if (calls.at(-1).method === 'POST') {
        return {
          task_id: 1,
          chart_id: body.values.chart_id,
          图表编号: 'CHAR-0001',
          图表名称: '区域销售趋势',
          dataset_code: 'DATA-0001',
          filters: body.values.filters,
          filter_hash: 'h',
          round_id: body.values.round_id,
          generation: 1,
          chart_status: '已启用',
          result_status: '生成中',
          created_at: 't',
          finished_at: null,
        }
      }
      return { items: store.exportTasks }
    }
    throw new Error(`未覆盖的路径 ${path}`)
  })

  store.applyNow()
  await sleep(20)
  assert.equal(store.rounds[0].status, '已结束', '筛选结束后轮次关闭')

  // 手动登记导出任务时，POST 体要带图表快照（筛选 + 代次 + 轮次）。
  const originalPost = calls.filter((c) => c.path.endsWith('/export-tasks') && c.method === 'POST')
  assert.equal(originalPost.length, 0)
  await store.createExportTask(1)
  const postCall = calls.find((c) => c.path.endsWith('/export-tasks') && c.method === 'POST')
  assert.equal(postCall.body.values.chart_id, 1)
  assert.deepEqual(postCall.body.values.filters, { 地区: '全部' })
  assert.ok('round_id' in postCall.body.values)
  console.log('ok testRoundAndExportTaskSnapshot')
}

for (const test of [
  testDebounceMergesRapidChanges,
  testStaleTokenResponseDropped,
  testStaleGenerationDropped,
  testManualRefreshBumpsGeneration,
  testRoundAndExportTaskSnapshot,
]) {
  await test()
}
console.log('all linkage store tests passed')
