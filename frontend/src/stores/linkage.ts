/**
 * 筛选联动取数 store：把「全局筛选器变化 → 合并取数 → 代次裁决 → 统一重绘 → 导出台账」
 * 这条链路的并发与缓存规则收在一处，看板页只负责渲染。
 *
 * 关键规则：
 * 1. 同一轮筛选变化只发起一次有效取数：连续切换走防抖，到期后合并成一次 /linkage/fetch；
 *    同一「数据集 + 代次 + 筛选快照」在后端单飞，共用数据集的图表复用同一份快照。
 * 2. 快速连续切换时只允许最后一次选择生效：每次取数携带递增的请求令牌与客户端已知代次，
 *    旧响应回来时令牌或代次对不上就丢弃，不能覆盖新结果（last-wins）。
 * 3. 手动刷新保留独立语义：立即取数、不参与防抖合并，并推进数据集代次、淘汰旧快照。
 * 4. 筛选结束后再统一更新可见图表：取数期间只更新加载态，数据回来后一次提交所有图表。
 * 5. 数据快照版本冲突以最新刷新代次为准：响应里 stale=true 的旧代次结果一律不上屏。
 */
import { request } from '@/api/client'

const LINKAGE_ENDPOINT = '/api/linkage'
/** 连续切换筛选器的合并窗口：窗口内的多次变化只会触发一次取数。 */
const FILTER_DEBOUNCE_MS = 300

export interface LinkageChart {
  chart_id: number
  图表编号: string
  图表名称: string
  图表类型: string
  dataset_code: string
  横轴字段: string
  纵轴字段: string
  刷新间隔: number
  status: string
}

export interface ChartSeriesPoint {
  x: string
  y: number
  x_field: string
  y_field: string
}

export interface FetchedChart {
  chart_id: number
  图表编号: string
  图表名称: string
  dataset_code: string
  generation: number
  expected_generation: number | null
  stale: boolean
  filter_hash: string
  filters: Record<string, string>
  cached: boolean
  fetched_at: string
  series: ChartSeriesPoint[]
}

export interface FetchRoundResponse {
  filters: Record<string, string>
  filter_hash: string
  generations: Record<string, number>
  forced: boolean
  charts: FetchedChart[]
  fetch_count: number
}

export interface FilterRound {
  round_id: number
  filters: Record<string, string>
  filter_hash: string
  status: string
  opened_at: string
  closed_at: string | null
  generations: Record<string, number>
}

export interface ExportTask {
  task_id: number
  chart_id: number
  图表编号: string
  图表名称: string
  dataset_code: string
  filters: Record<string, string>
  filter_hash: string
  round_id: number | null
  generation: number
  chart_status: string
  result_status: string
  created_at: string
  finished_at: string | null
}

export interface OverviewResponse {
  filter_options: Record<string, string[]>
  datasets: Array<{ dataset_code: string; generation: number; cached_snapshots: number }>
  charts: LinkageChart[]
  rounds: FilterRound[]
  export_tasks: ExportTask[]
  fetch_count: number
}

type Listener = () => void

async function postJson<T>(path: string, values: Record<string, unknown>): Promise<T> {
  const response = await request(path, {
    method: 'POST',
    body: JSON.stringify({ values }),
  })
  if (!response.ok) {
    throw new Error(`联动接口返回 ${response.status}，操作未生效`)
  }
  return (await response.json()) as T
}

export class LinkageStore {
  /** 全局筛选器当前选择（输入态，连续切换时先改这里）。 */
  filters: Record<string, string> = {}
  /** 最近一次真正上屏的筛选快照，用来判断这一轮是否产生了新取数。 */
  appliedFilters: Record<string, string> = {}
  charts: LinkageChart[] = []
  filterOptions: Record<string, string[]> = {}
  datasets: OverviewResponse['datasets'] = []
  rounds: FilterRound[] = []
  exportTasks: ExportTask[] = []
  /** chart_id -> 最新一代可上屏的取数结果。 */
  chartData = new Map<number, FetchedChart>()
  /** 客户端已知的各数据集最新代次，裁决旧响应时使用。 */
  knownGenerations: Record<string, number> = {}
  loading = false
  fetchCount = 0
  lastError = ''
  /** 被丢弃的过期响应计数，便于在页面上观察 last-wins 是否生效。 */
  droppedResponses = 0
  /** store 版本号：每次状态提交 +1，供 useSyncExternalStore 判断快照是否变化。 */
  version = 0

  private listeners = new Set<Listener>()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  /** 取数令牌：每发起一轮取数 +1，旧令牌的响应一律丢弃。 */
  private requestToken = 0
  /** 当前打开的筛选轮次，筛选结束时关闭并回写导出台账。 */
  private activeRoundId: number | null = null

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    this.version += 1
    this.listeners.forEach((listener) => listener())
  }

  async loadOverview(): Promise<void> {
    const response = await request(`${LINKAGE_ENDPOINT}/overview`)
    if (!response.ok) {
      throw new Error('联动看板初始数据读取失败')
    }
    const payload = (await response.json()) as OverviewResponse
    this.charts = payload.charts
    this.filterOptions = payload.filter_options
    this.datasets = payload.datasets
    this.rounds = payload.rounds
    this.exportTasks = payload.export_tasks
    this.fetchCount = payload.fetch_count
    this.knownGenerations = Object.fromEntries(
      payload.datasets.map((item) => [item.dataset_code, item.generation]),
    )
    if (Object.keys(this.filters).length === 0) {
      this.filters = { 地区: payload.filter_options['地区']?.[0] ?? '全部' }
    }
    this.emit()
  }

  /**
   * 筛选器变化入口：更新输入态并把取数合并到防抖窗口尾部。
   * 连续切到华东、华南、华北时，只有华北这一轮会真正发起取数。
   */
  onFilterChange(key: string, value: string): void {
    this.filters = { ...this.filters, [key]: value }
    this.lastError = ''
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.commitFilterRound()
    }, FILTER_DEBOUNCE_MS)
    this.emit()
  }

  /** 查询按钮：跳过防抖立即提交一轮筛选。 */
  applyNow(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    void this.commitFilterRound()
  }

  /**
   * 提交一轮筛选：登记轮次快照 -> 合并取数 -> 代次/令牌裁决 -> 统一上屏 -> 关闭轮次。
   */
  private async commitFilterRound(): Promise<void> {
    const snapshot = { ...this.filters }
    const round = await postJson<FilterRound>(`${LINKAGE_ENDPOINT}/rounds`, { filters: snapshot })
    this.activeRoundId = round.round_id
    this.rounds = [...this.rounds, round]
    this.loading = true
    this.emit()

    const token = ++this.requestToken
    try {
      const result = await postJson<FetchRoundResponse>(`${LINKAGE_ENDPOINT}/fetch`, {
        filters: snapshot,
        expected_generations: { ...this.knownGenerations },
      })
      // 并发裁决：快速连续切换时，只允许最后一次选择（最大令牌）的结果生效。
      if (token !== this.requestToken) {
        this.droppedResponses += 1
      } else {
        this.acceptRound(result, snapshot)
      }
    } catch (error) {
      if (token === this.requestToken) {
        this.lastError = error instanceof Error ? error.message : '联动取数失败'
        this.loading = false
        this.emit()
      }
    } finally {
      // 无论结果是否被新轮次取代，本轮筛选都已结束，台账要回写这一轮的状态。
      await this.closeRound(round.round_id)
    }
  }

  /**
   * 手动刷新：独立语义，立即执行且不与防抖中的筛选合并。
   * 后端推进代次并淘汰旧快照；返回的新代次更新本地代次表，旧代次结果之后都会被判过期。
   */
  async manualRefresh(datasetCode?: string): Promise<void> {
    const target = datasetCode ?? this.datasets[0]?.dataset_code
    if (!target) {
      return
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    await postJson(`${LINKAGE_ENDPOINT}/datasets/refresh`, { dataset_code: target })
    const snapshot = { ...this.filters }
    const round = await postJson<FilterRound>(`${LINKAGE_ENDPOINT}/rounds`, { filters: snapshot })
    this.activeRoundId = round.round_id
    this.rounds = [...this.rounds, round]
    this.loading = true
    this.emit()

    const token = ++this.requestToken
    try {
      const result = await postJson<FetchRoundResponse>(`${LINKAGE_ENDPOINT}/fetch`, {
        filters: snapshot,
        expected_generations: { ...this.knownGenerations },
        force: true,
      })
      if (token !== this.requestToken) {
        this.droppedResponses += 1
      } else {
        this.acceptRound(result, snapshot)
      }
    } catch (error) {
      if (token === this.requestToken) {
        this.lastError = error instanceof Error ? error.message : '手动刷新失败'
        this.loading = false
        this.emit()
      }
    } finally {
      await this.closeRound(round.round_id)
    }
  }

  /**
   * 统一接收一轮结果：旧代次（stale）图表丢弃不上屏，其余图表一次性替换，
   * 保证可见图表在筛选结束后同一刻更新，而不是陆续闪烁。
   */
  private acceptRound(result: FetchRoundResponse, snapshot: Record<string, string>): void {
    const next = new Map<number, FetchedChart>()
    for (const chart of result.charts) {
      const known = this.knownGenerations[chart.dataset_code]
      const generationClash = known !== undefined && chart.generation < known
      if (chart.stale || generationClash) {
        // 数据快照版本冲突：以最新刷新代次为准，旧响应丢弃。
        this.droppedResponses += 1
        const previous = this.chartData.get(chart.chart_id)
        if (previous) {
          next.set(chart.chart_id, previous)
        }
        continue
      }
      next.set(chart.chart_id, chart)
      this.knownGenerations[chart.dataset_code] = chart.generation
    }
    this.chartData = next
    this.appliedFilters = snapshot
    this.fetchCount = result.fetch_count
    this.datasets = this.datasets.map((item) => ({
      ...item,
      generation: result.generations[item.dataset_code] ?? item.generation,
      cached_snapshots: item.cached_snapshots,
    }))
    this.loading = false
    this.emit()
  }

  private async closeRound(roundId: number): Promise<void> {
    if (this.activeRoundId === roundId) {
      this.activeRoundId = null
    }
    const closed = await postJson<FilterRound>(`${LINKAGE_ENDPOINT}/rounds/${roundId}/close`, {})
    this.rounds = this.rounds.map((item) => (item.round_id === roundId ? closed : item))
    await this.refreshExportTasks()
  }

  /** 登记导出任务：台账记录当前图表快照（筛选快照 + 数据代次）。 */
  async createExportTask(chartId: number): Promise<void> {
    const task = await postJson<ExportTask>(`${LINKAGE_ENDPOINT}/export-tasks`, {
      chart_id: chartId,
      filters: { ...this.appliedFilters },
      round_id: this.activeRoundId,
    })
    this.exportTasks = [...this.exportTasks, task]
    this.emit()
  }

  /** 别的入口读取同一份台账：结果状态始终与当前图表配置、数据代次同步。 */
  async refreshExportTasks(): Promise<void> {
    const response = await request(`${LINKAGE_ENDPOINT}/export-tasks`)
    if (!response.ok) {
      return
    }
    const payload = (await response.json()) as { items: ExportTask[] }
    this.exportTasks = payload.items
    this.emit()
  }

  get visibleCharts(): LinkageChart[] {
    return this.charts.filter((chart) => chart.status !== '已停用')
  }
}

export const linkageStore = new LinkageStore()
