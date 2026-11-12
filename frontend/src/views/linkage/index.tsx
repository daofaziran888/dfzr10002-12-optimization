import { useEffect, useMemo, useState } from 'react'

import { useLinkageStore } from '@/hooks/useLinkageStore'
import type { ExportTask, LinkageChart } from '@/stores/linkage'

const STATUS_CLASS: Record<string, string> = {
  已完成: 'tag tag-ok',
  生成中: 'tag tag-running',
  待生成: 'tag tag-pending',
  已过期: 'tag tag-stale',
  已停用: 'tag tag-off',
}

function formatFilters(filters: Record<string, string>): string {
  const entries = Object.entries(filters)
  if (entries.length === 0) {
    return '—'
  }
  return entries.map(([key, value]) => `${key}=${value}`).join('，')
}

function ChartCard({ chart, exportingId, onExport }: {
  chart: LinkageChart
  exportingId: number | null
  onExport: (chartId: number) => void
}) {
  const store = useLinkageStore()
  const data = store.chartData.get(chart.chart_id)
  const maxY = useMemo(() => {
    if (!data || data.series.length === 0) {
      return 0
    }
    return Math.max(...data.series.map((point) => Number(point.y) || 0))
  }, [data])

  return (
    <article className="chart-card">
      <header className="chart-card-head">
        <div>
          <strong>{chart.图表名称}</strong>
          <span className="chart-meta">
            {chart.图表编号} · {chart.图表类型} · 数据集 {chart.dataset_code}
          </span>
        </div>
        <span className="chart-interval">每 {chart.刷新间隔}s 刷新</span>
      </header>
      <div className="chart-axis">
        <span>纵轴：{chart.纵轴字段}</span>
        <span>横轴：{chart.横轴字段}</span>
      </div>
      <div className="chart-body">
        {!data && <span className="chart-placeholder">等待本轮筛选取数…</span>}
        {data && (
          <div className="bar-list">
            {data.series.map((point, index) => (
              <div className="bar-row" key={`${point.x}-${index}`}>
                <span className="bar-label" title={point.x}>{point.x}</span>
                <span className="bar-track">
                  <span
                    className="bar-fill"
                    style={{ width: `${maxY ? Math.round((Number(point.y) / maxY) * 100) : 0}%` }}
                  />
                </span>
                <span className="bar-value">{point.y}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <footer className="chart-card-foot">
        <span className="chart-snapshot">
          {data ? `代次 ${data.generation} · ${data.cached ? '快照复用' : '新取数'}` : '尚无快照'}
        </span>
        <button
          className="btn"
          type="button"
          disabled={exportingId === chart.chart_id}
          onClick={() => onExport(chart.chart_id)}
        >
          {exportingId === chart.chart_id ? '登记中…' : '登记导出任务'}
        </button>
      </footer>
    </article>
  )
}

export default function LinkageView() {
  const store = useLinkageStore()
  const [exportingId, setExportingId] = useState<number | null>(null)
  const [taskChartFilter, setTaskChartFilter] = useState('')

  useEffect(() => {
    void store.loadOverview().then(() => {
      // 首屏自动跑一轮，验证默认筛选下的合并取数。
      void store.applyNow()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filterEntries = Object.entries(store.filterOptions)
  const visibleCharts = store.visibleCharts
  const filteredTasks = useMemo(() => {
    const keyword = taskChartFilter.trim()
    if (!keyword) {
      return store.exportTasks
    }
    return store.exportTasks.filter((task) => task.图表编号.includes(keyword))
  }, [store.exportTasks, taskChartFilter])

  async function handleExport(chartId: number) {
    setExportingId(chartId)
    try {
      await store.createExportTask(chartId)
    } finally {
      setExportingId(null)
    }
  }

  return (
    <section className="page" data-module="linkage">
      <header className="page-head">
        <div>
          <h2>全局筛选联动看板</h2>
          <p className="page-desc">
            连续切换筛选器只按最后一次选择合并取数；同数据集快照跨图表复用，手动刷新推进代次，
            旧响应自动丢弃，筛选结束后统一重绘并回写导出台账。
          </p>
        </div>
        <div className="page-actions">
          <select
            className="btn"
            value={store.datasets[0]?.dataset_code ?? ''}
            onChange={(event) => void store.manualRefresh(event.target.value)}
          >
            {store.datasets.map((item) => (
              <option key={item.dataset_code} value={item.dataset_code}>
                手动刷新 {item.dataset_code}（当前代次 {item.generation}）
              </option>
            ))}
          </select>
          <button className="btn primary" type="button" onClick={() => void store.manualRefresh()}>
            手动刷新首轮数据集
          </button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">可见图表</span>
          <strong className="stat-value">{visibleCharts.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">实际取数次数（含缓存复用）</span>
          <strong className="stat-value">{store.fetchCount}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">被丢弃的过期/旧轮次响应</span>
          <strong className="stat-value">{store.droppedResponses}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">导出任务台账</span>
          <strong className="stat-value">{store.exportTasks.length}</strong>
        </article>
      </div>

      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
          store.applyNow()
        }}
      >
        {filterEntries.map(([key, options]) => (
          <label key={key} className="filter-item">
            <span>{key}（连续切换自动合并）</span>
            <select
              value={store.filters[key] ?? options[0]}
              onChange={(event) => store.onFilterChange(key, event.target.value)}
            >
              {options.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        ))}
        <button className="btn primary" type="submit">立即查询</button>
        <span className="filter-snapshot">
          当前输入：{formatFilters(store.filters)} ｜ 已上屏：{formatFilters(store.appliedFilters)}
        </span>
        {store.loading && <span className="tag tag-running">本轮合并取数中…</span>}
        {store.lastError && <span className="error-text">{store.lastError}</span>}
      </form>

      <div className="chart-grid">
        {visibleCharts.map((chart) => (
          <ChartCard
            key={chart.chart_id}
            chart={chart}
            exportingId={exportingId}
            onExport={(id) => void handleExport(id)}
          />
        ))}
      </div>

      <div className="ledger-grid">
        <article className="ledger-card">
          <h3>筛选轮次台账（本轮筛选快照）</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>轮次</th>
                <th>筛选快照</th>
                <th>快照指纹</th>
                <th>状态</th>
                <th>开启时间</th>
                <th>结束时间</th>
              </tr>
            </thead>
            <tbody>
              {store.rounds.slice().reverse().map((round) => (
                <tr key={round.round_id}>
                  <td>#{round.round_id}</td>
                  <td>{formatFilters(round.filters)}</td>
                  <td>{round.filter_hash}</td>
                  <td>{round.status}</td>
                  <td>{round.opened_at}</td>
                  <td>{round.closed_at ?? '—'}</td>
                </tr>
              ))}
              {store.rounds.length === 0 && (
                <tr><td className="empty-state" colSpan={6}>暂无筛选轮次</td></tr>
              )}
            </tbody>
          </table>
        </article>

        <article className="ledger-card">
          <div className="ledger-head">
            <h3>数据导出任务清单（图表快照）</h3>
            <input
              placeholder="按图表编号检索台账"
              value={taskChartFilter}
              onChange={(event) => setTaskChartFilter(event.target.value)}
            />
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>图表编号</th>
                <th>筛选快照 / 代次</th>
                <th>关联轮次</th>
                <th>图表状态</th>
                <th>结果状态</th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.slice().reverse().map((task: ExportTask) => (
                <tr key={task.task_id}>
                  <td>#{task.task_id}</td>
                  <td>{task.图表编号}</td>
                  <td>{formatFilters(task.filters)} / G{task.generation}</td>
                  <td>{task.round_id === null ? '—' : `#${task.round_id}`}</td>
                  <td>{task.chart_status}</td>
                  <td>
                    <span className={STATUS_CLASS[task.result_status] ?? 'tag'}>
                      {task.result_status}
                    </span>
                  </td>
                </tr>
              ))}
              {filteredTasks.length === 0 && (
                <tr><td className="empty-state" colSpan={6}>暂无导出任务，可在图表卡上登记</td></tr>
              )}
            </tbody>
          </table>
        </article>
      </div>
    </section>
  )
}
