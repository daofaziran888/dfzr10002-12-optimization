"""筛选联动接口：看板配置、合并取数、数据集刷新、筛选轮次与导出任务台账。

接口分组：
* GET  /api/linkage/overview        联动看板初始数据（图表配置、筛选选项、代次、轮次与台账）
* POST /api/linkage/fetch           一轮筛选的合并取数（单飞 + 快照缓存，旧代次标记 stale）
* GET  /api/linkage/charts          参与联动的图表配置
* POST /api/linkage/datasets/refresh  手动刷新数据集，推进代次并淘汰旧快照
* POST /api/linkage/rounds          登记筛选轮次（固化筛选快照）
* POST /api/linkage/rounds/{id}/close 筛选结束，统一回写台账结果状态
* GET  /api/linkage/rounds          筛选轮次台账
* POST /api/linkage/export-tasks    登记导出任务（记录图表快照）
* GET  /api/linkage/export-tasks    导出任务清单，可按图表过滤
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.schemas import EntryPayload
from app.services.linkage import REGION_VALUES, linkage_service

router = APIRouter(prefix="/api/linkage", tags=["筛选联动"])


def _payload_filters(payload: EntryPayload) -> dict[str, Any]:
    values = payload.values or {}
    filters = values.get("filters")
    if filters is None:
        # 兼容直接平铺筛选键的调用方式。
        filters = {key: value for key, value in values.items() if key not in {"force", "round_id"}}
    if not isinstance(filters, dict):
        raise HTTPException(status_code=400, detail="filters 必须是筛选键值对象")
    return filters


@router.get("/overview")
def overview() -> dict[str, Any]:
    """联动看板首屏数据：图表配置、筛选选项、当前代次、轮次与导出任务台账一次带齐。"""
    return {
        "filter_options": {"地区": REGION_VALUES},
        "datasets": linkage_service.datasets(),
        "charts": linkage_service.linkage_charts(),
        "rounds": linkage_service.list_rounds(),
        "export_tasks": linkage_service.list_export_tasks(),
        "fetch_count": linkage_service.fetch_count,
    }


@router.get("/charts")
def list_charts() -> dict[str, Any]:
    """参与联动的图表配置清单，坐标轴与刷新间隔按配置原样返回。"""
    return {"items": linkage_service.linkage_charts()}


@router.post("/fetch")
async def fetch_round(payload: EntryPayload) -> dict[str, Any]:
    """一轮筛选只发起一次有效取数：同数据集快照单飞合并，结果按图表配置投影。

    响应里每张图表带 ``generation`` 与 ``stale``；调用方只允许最新代次结果上屏，
    ``stale=True`` 的旧响应必须丢弃。
    """
    values = payload.values or {}
    filters = _payload_filters(payload)
    force = bool(values.get("force", False))
    expected = values.get("expected_generations")
    if expected is not None and not isinstance(expected, dict):
        raise HTTPException(status_code=400, detail="expected_generations 必须是数据集到代次的映射")
    return await linkage_service.fetch_round(
        filters=filters,
        expected_generations=expected,
        force=force,
    )


@router.post("/datasets/refresh")
def refresh_dataset(payload: EntryPayload) -> dict[str, Any]:
    """手动刷新分析数据集：推进代次、清空旧快照，后续取数只命中新代次。"""
    dataset_code = str((payload.values or {}).get("dataset_code") or "").strip()
    if not dataset_code:
        raise HTTPException(status_code=400, detail="dataset_code 不能为空")
    return linkage_service.refresh_dataset(dataset_code)


@router.post("/rounds")
def open_round(payload: EntryPayload) -> dict[str, Any]:
    """登记一轮筛选变化并固化筛选快照，供导出台账追溯本轮筛选口径。"""
    return linkage_service.open_round(_payload_filters(payload))


@router.post("/rounds/{round_id}/close")
def close_round(round_id: int) -> dict[str, Any]:
    """筛选结束：关闭轮次并把关联导出任务统一更新为完成态。"""
    try:
        return linkage_service.close_round(round_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/rounds")
def list_rounds() -> dict[str, Any]:
    """筛选轮次台账：每轮筛选快照、状态与当时的数据集代次。"""
    return {"items": linkage_service.list_rounds()}


@router.post("/export-tasks")
def create_export_task(payload: EntryPayload) -> dict[str, Any]:
    """登记导出任务：记录图表编号、筛选快照与数据代次，即图表快照。"""
    values = payload.values or {}
    try:
        chart_id = int(values["chart_id"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="chart_id 必须是有效图表编号") from exc
    round_id = values.get("round_id")
    if round_id is not None:
        try:
            round_id = int(round_id)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="round_id 必须是轮次编号") from exc
    try:
        return linkage_service.create_export_task(
            chart_id=chart_id,
            filters=_payload_filters(payload),
            round_id=round_id,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/export-tasks")
def list_export_tasks(
    chart_id: int | None = Query(default=None, description="按图表编号过滤台账"),
) -> dict[str, Any]:
    """导出任务清单：别的入口也按图表快照读取，结果状态与当前图表配置同步。"""
    return {"items": linkage_service.list_export_tasks(chart_id=chart_id)}
