import { useCallback, useEffect, useMemo, useState } from 'react'

import { request } from '@/api/client'
import type { ExportTask } from '@/stores/linkage'

const ENDPOINT = '/api/export'
const columns = [
  "模板编号",
  "模板名称",
  "数据源绑定",
  "导出格式",
  "字段选择",
  "筛选参数",
  "导出上限",
  "是否启用"
]
const actions = [
  "提交校验",
  "启用配置",
  "停用配置"
]
const statuses = [
  "草稿",
  "待校验",
  "已启用",
  "已停用"
]
const stats = [
  {
    "label": "导出模板总数",
    "value": 0
  },
  {
    "label": "待校验导出模板",
    "value": 0
  },
  {
    "label": "已启用导出模板",
    "value": 0
  }
]

const TASK_STATUS_CLASS: Record<string, string> = {
  已完成: 'tag tag-ok',
  生成中: 'tag tag-running',
  待生成: 'tag tag-pending',
  已过期: 'tag tag-stale',
  已停用: 'tag tag-off',
}

type Row = Record<string, string | number | null>

function formatTaskFilters(filters: Record<string, string>): string {
  const entries = Object.entries(filters)
  return entries.length === 0 ? '—' : entries.map(([key, value]) => `${key}=${value}`).join('，')
}

export default function ExportView() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])
  // 图表快照任务台账：与联动看板读同一个接口，结果状态始终和图表配置/数据代次同步。
  const [tasks, setTasks] = useState<ExportTask[]>([])
  const [taskKeyword, setTaskKeyword] = useState('')

  const reload = useCallback(async () => {
    setErrorMessage('')
    const query = new URLSearchParams(filters).toString()
    try {
      const response = await request(`${ENDPOINT}?${query}`)
      if (!response.ok) {
        throw new Error('导出模板列表读取失败')
      }
      const payload = await response.json()
      setRows(payload.items ?? [])
      setTotal(payload.total ?? 0)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '数据导出配置列表读取失败')
    }
  }, [filters])

  const reloadTasks = useCallback(async () => {
    try {
      const response = await request('/api/linkage/export-tasks')
      if (response.ok) {
        const payload = await response.json()
        setTasks(payload.items ?? [])
      }
    } catch {
      // 台账读取失败不阻断模板列表主流程。
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    void reloadTasks()
    // 每 5 秒拉一次台账，联动看板里筛选结束或图表状态变化后，本入口自动同步结果状态。
    const timer = setInterval(() => void reloadTasks(), 5000)
    return () => clearInterval(timer)
  }, [reloadTasks])

  const visibleTasks = useMemo(() => {
    const keyword = taskKeyword.trim()
    if (!keyword) {
      return tasks
    }
    return tasks.filter((task) => task.图表编号.includes(keyword))
  }, [tasks, taskKeyword])

  async function runAction(action: string, row: Row) {
    setErrorMessage('')
    try {
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      if (!response.ok) {
        throw new Error('数据导出配置动作未生效，请稍后重试')
      }
      await reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '数据导出配置操作失败')
    }
  }

  return (
    <section className="page" data-module="export">
      <header className="page-head">
        <div>
          <h2>数据导出配置管理</h2>
          <p className="page-desc">维护分析结果的导出模板、格式配置与行数控制，实现分析数据灵活输出。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('导出模板登记入口尚未接入审批流')}>
            登记导出模板
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出数据导出配置清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); void reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => void runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 1}>暂无数据导出配置数据，可先登记导出模板</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条数据导出配置记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>

      <div className="ledger-card export-ledger">
        <div className="ledger-head">
          <h3>数据导出任务清单（跟随图表快照）</h3>
          <input
            placeholder="按图表编号检索任务"
            value={taskKeyword}
            onChange={(event) => setTaskKeyword(event.target.value)}
          />
          <button className="btn" type="button" onClick={() => void reloadTasks()}>刷新台账</button>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>任务</th>
              <th>图表编号</th>
              <th>图表名称</th>
              <th>筛选快照</th>
              <th>数据代次</th>
              <th>图表状态</th>
              <th>结果状态</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {visibleTasks.slice().reverse().map((task) => (
              <tr key={task.task_id}>
                <td>#{task.task_id}</td>
                <td>{task.图表编号}</td>
                <td>{task.图表名称}</td>
                <td>{formatTaskFilters(task.filters)}</td>
                <td>G{task.generation}</td>
                <td>{task.chart_status}</td>
                <td>
                  <span className={TASK_STATUS_CLASS[task.result_status] ?? 'tag'}>
                    {task.result_status}
                  </span>
                </td>
                <td>{task.created_at}</td>
              </tr>
            ))}
            {visibleTasks.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={8}>
                  暂无导出任务，可在「全局筛选联动」看板的图表卡上登记
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
