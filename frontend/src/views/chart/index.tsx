import { useCallback, useEffect, useMemo, useState } from 'react'

import { request } from '@/api/client'

const ENDPOINT = '/api/chart'
const PAGE_SIZE = 3
const columns = [
  "图表编号",
  "图表名称",
  "图表类型",
  "数据源绑定",
  "横轴字段",
  "纵轴字段",
  "筛选条件",
  "刷新间隔"
]
const actions = [
  "提交校验",
  "启用配置",
  "停用配置"
]

type Row = Record<string, string | number | null>
type SortOrder = 'asc' | 'desc'

interface PagePayload {
  items: Row[]
  total: number
  page: number
  size: number
}

export default function ChartView() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [errorMessage, setErrorMessage] = useState('')
  // 输入态与已生效查询条件分离：翻页、排序都带着已生效条件，输入过程不触发请求。
  const [keywordInput, setKeywordInput] = useState('')
  const [statusInput, setStatusInput] = useState('')
  const [query, setQuery] = useState<{ keyword: string; status: string }>({ keyword: '', status: '' })
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total])

  const reload = useCallback(async () => {
    setErrorMessage('')
    const params = new URLSearchParams()
    if (query.keyword) {
      params.set('keyword', query.keyword)
    }
    if (query.status) {
      params.set('status', query.status)
    }
    // 筛选条件、排序与分页范围同时生效：后端先过滤排序再分页。
    params.set('sort_by', '刷新间隔')
    params.set('order', sortOrder)
    params.set('page', String(page))
    params.set('size', String(PAGE_SIZE))
    try {
      const response = await request(`${ENDPOINT}?${params.toString()}`)
      if (!response.ok) {
        throw new Error('图表配置列表读取失败')
      }
      const payload = (await response.json()) as PagePayload
      setRows(payload.items ?? [])
      setTotal(payload.total ?? 0)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '可视化图表配置列表读取失败')
    }
  }, [query, sortOrder, page])

  useEffect(() => {
    void reload()
  }, [reload])

  // 查询条件变化时回到第一页，但排序变化保留当前页定位。
  function submitSearch(event: React.FormEvent) {
    event.preventDefault()
    setPage(1)
    setQuery({ keyword: keywordInput.trim(), status: statusInput })
  }

  function resetSearch() {
    setKeywordInput('')
    setStatusInput('')
    setQuery({ keyword: '', status: '' })
    setPage(1)
  }

  function toggleSort() {
    setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
  }

  async function runAction(action: string, row: Row) {
    setErrorMessage('')
    try {
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      if (!response.ok) {
        throw new Error('可视化图表配置动作未生效，请稍后重试')
      }
      await reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '可视化图表配置操作失败')
    }
  }

  return (
    <section className="page" data-module="chart">
      <header className="page-head">
        <div>
          <h2>可视化图表配置管理</h2>
          <p className="page-desc">维护可视化图表的类型选择、数据绑定与样式配置，实现分析结果可视化。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('图表配置登记入口尚未接入审批流')}>
            登记图表配置
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出可视化图表配置清单
          </button>
        </div>
      </header>

      <form className="filter-bar" onSubmit={submitSearch}>
        <label className="filter-item">
          <span>图表编号检索</span>
          <input
            value={keywordInput}
            placeholder="按图表编号检索，如 CHAR-000"
            onChange={(event) => setKeywordInput(event.target.value)}
          />
        </label>
        <label className="filter-item">
          <span>配置状态</span>
          <select value={statusInput} onChange={(event) => setStatusInput(event.target.value)}>
            <option value="">全部状态</option>
            <option value="草稿">草稿</option>
            <option value="待校验">待校验</option>
            <option value="已启用">已启用</option>
            <option value="已停用">已停用</option>
          </select>
        </label>
        <button className="btn primary" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={resetSearch}>重置条件</button>
        <button className="btn" type="button" onClick={toggleSort}>
          刷新间隔{sortOrder === 'asc' ? '升序 ↑' : '降序 ↓'}
        </button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>
                {column}
                {column === '刷新间隔' && (
                  <button className="link sort-link" type="button" onClick={toggleSort}>
                    {sortOrder === 'asc' ? '↑' : '↓'}
                  </button>
                )}
              </th>
            ))}
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
              <td className="empty-state" colSpan={columns.length + 1}>暂无可视化图表配置数据，可先登记图表配置</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot pagination-foot">
        <span>
          共 {total} 条记录，第 {page} / {totalPages} 页
          {query.keyword && ` · 编号含「${query.keyword}」`}
          {query.status && ` · 状态「${query.status}」`}
        </span>
        <span className="pagination">
          <button className="btn" type="button" disabled={page <= 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
            上一页
          </button>
          {Array.from({ length: totalPages }, (_, index) => index + 1).map((pageNo) => (
            <button
              key={pageNo}
              className={`btn ${pageNo === page ? 'primary' : ''}`}
              type="button"
              onClick={() => setPage(pageNo)}
            >
              {pageNo}
            </button>
          ))}
          <button
            className="btn"
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
          >
            下一页
          </button>
        </span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
