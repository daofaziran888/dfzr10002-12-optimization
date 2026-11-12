"""可视化图表配置接口：维护图表配置，覆盖提交校验、启用配置、停用配置等动作。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.schemas import ActionResult, EntryPayload, PageResult
from app.services.chart import ChartService

router = APIRouter(prefix="/api/chart", tags=["可视化图表配置"])

service = ChartService()

LIST_FIELDS = ["图表编号", "图表名称", "图表类型", "数据源绑定", "横轴字段", "纵轴字段", "筛选条件", "刷新间隔"]
STATUSES = ["草稿", "待校验", "已启用", "已停用"]


@router.get("", response_model=PageResult[dict])
def list_entries(
    keyword: str | None = Query(default=None, description="按图表编号检索"),
    status: str | None = Query(default=None, description="草稿、待校验、已启用、已停用"),
    sort_by: str | None = Query(default=None, description="排序字段，支持 刷新间隔、图表编号"),
    order: str = Query(default="asc", description="排序方向：asc 升序、desc 降序"),
    page: int = 1,
    size: int = 20,
) -> PageResult[dict]:
    """按图表编号检索、按刷新间隔排序并分页；筛选条件与分页范围同时生效。"""
    if size > 200:
        raise HTTPException(status_code=400, detail="每页最多 200 条，请缩小分页范围")
    if order not in ("asc", "desc"):
        raise HTTPException(status_code=400, detail="order 只支持 asc 或 desc")
    items, total = service.list_entries(
        keyword=keyword,
        status=status,
        sort_by=sort_by,
        order=order,
        page=page,
        size=size,
    )
    return PageResult(items=items, total=total, page=page, size=size)


@router.get("/{entry_id}", response_model=dict)
def get_entry(entry_id: int) -> dict:
    """读取单条图表配置明细；不存在时给出可读的错误说明。"""
    entry = service.get_entry(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"图表配置 {entry_id} 不存在或已归档")
    return entry


@router.post("", response_model=ActionResult)
def create_entry(payload: EntryPayload) -> ActionResult:
    """登记一条图表配置，缺字段时说明原因而不是静默丢弃。"""
    entry, missing = service.create_entry(payload.values)
    if missing:
        return ActionResult(ok=False, message=f"缺少必填字段：{'、'.join(missing)}")
    return ActionResult(ok=True, message="图表配置已登记", entry=entry)


@router.post("/{entry_id}/actions", response_model=ActionResult)
def run_action(entry_id: int, payload: EntryPayload) -> ActionResult:
    """对单条图表配置执行提交校验、启用配置、停用配置；不允许的动作会被拦下并说明原因。"""
    action = str(payload.values.get("action") or "").strip()
    entry, message = service.run_action(entry_id, action)
    if entry is None:
        return ActionResult(ok=False, message=message)
    return ActionResult(ok=True, message=message, entry=entry)


@router.get("/export")
def export_entries() -> dict[str, Any]:
    """导出可视化图表配置清单：返回当前过滤条件下的全量数据。"""
    items, total = service.list_entries(page=1, size=10000)
    return {"module": "chart", "total": total, "items": items}
