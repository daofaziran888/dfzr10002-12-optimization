"""筛选联动取数服务。

把「全局筛选器变化 → 图表取数 → 联动重绘 → 导出台账」这条链路的并发与缓存规则收在一处：

* 代次（generation）：分析数据集每刷新一次，代次 +1。数据快照版本冲突时一律以最新代次为准，
  旧代次的响应回到前端也会被识别为过期数据并丢弃，不能覆盖新结果。
* 筛选轮次（filter round）：连续切换筛选器时，每次变化登记一个轮次并记录筛选快照；
  同一轮次内多张图表共用同一份数据集快照，只发起一次有效取数（单飞 + 快照缓存）。
* 单飞合并（single-flight）：同一个「数据集 + 代次 + 筛选快照」并发取数时，合并到同一个
  协程上，图表之间不再互相等待、不重复请求完整数据。
* 手动刷新：显式触发的刷新会推进代次并清空旧缓存，旧代次缓存不再命中，保证拿到新一轮数据。
* 导出任务台账：记录每个任务对应的图表快照（代次 + 筛选快照），筛选轮次结束后统一回写结果
  状态；图表配置状态变化时，台账里关联任务的结果状态同步更新。
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import time
from typing import Any

from app.store import store

CHART_MODULE = "chart"
DATASET_MODULE = "dataset"

# 全局筛选器可选值，演示用地区筛选。
REGION_VALUES = ["全部", "华东", "华南", "华北", "华中", "西南"]
# 数据集刷新的模拟耗时，用来验证并发合并与旧响应丢弃。
SNAPSHOT_LATENCY_SECONDS = 0.15

# 导出任务结果状态机。
TASK_PENDING = "待生成"
TASK_RUNNING = "生成中"
TASK_DONE = "已完成"
TASK_STALE = "已过期"
TASK_DISABLED = "已停用"

ROUND_OPEN = "进行中"
ROUND_CLOSED = "已结束"


def snapshot_filter_hash(filters: dict[str, Any]) -> str:
    """筛选快照指纹：同样的筛选条件稳定命中同一份缓存。"""
    canonical = json.dumps(filters, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:12]


class LinkageService:
    """内存态联动控制器：进程内单例，路由层只做参数转发。"""

    def __init__(self) -> None:
        # 数据集代次：数据集编号 -> 当前代次。
        self._generations: dict[str, int] = {}
        # 快照缓存：(数据集编号, 代次, 筛选指纹) -> 快照数据。
        self._snapshot_cache: dict[tuple[str, int, str], dict[str, Any]] = {}
        # 单飞中的取数协程：同一个 key 只允许一个实际取数。
        self._inflight: dict[tuple[str, int, str], asyncio.Future[dict[str, Any]]] = {}
        # 数据集实际取数次数，用于验证合并与缓存命中。
        self.fetch_count = 0

        # 筛选轮次台账：round_id -> 轮次记录。
        self._rounds: dict[int, dict[str, Any]] = {}
        self._round_seq = 0
        # 导出任务台账：task_id -> 任务记录。
        self._tasks: dict[int, dict[str, Any]] = {}
        self._task_seq = 0

    # ------------------------------------------------------------------
    # 配置读取：联动图表与数据集都来自现有图表配置 / 数据集模块
    # ------------------------------------------------------------------
    def linkage_charts(self) -> list[dict[str, Any]]:
        """读取参与联动的图表配置，保留刷新间隔、坐标轴等配置差异。"""
        charts = []
        for row in store.rows(CHART_MODULE):
            charts.append({
                "chart_id": int(row["id"]),
                "图表编号": row.get("图表编号"),
                "图表名称": row.get("图表名称"),
                "图表类型": row.get("图表类型"),
                "dataset_code": row.get("数据源绑定"),
                "横轴字段": row.get("横轴字段"),
                "纵轴字段": row.get("纵轴字段"),
                "刷新间隔": self._to_int(row.get("刷新间隔"), default=60),
                "status": row.get("status"),
            })
        charts.sort(key=lambda item: item["chart_id"])
        return charts

    def datasets(self) -> list[dict[str, Any]]:
        """联动看板可选的分析数据集，附带当前刷新代次。"""
        codes: list[str] = []
        for chart in self.linkage_charts():
            code = chart["dataset_code"]
            if code and code not in codes:
                codes.append(code)
        result = []
        for code in codes:
            result.append({
                "dataset_code": code,
                "generation": self._generations.get(code, 1),
                "cached_snapshots": sum(1 for key in self._snapshot_cache if key[0] == code),
            })
        return result

    # ------------------------------------------------------------------
    # 数据集刷新：推进代次、淘汰旧快照
    # ------------------------------------------------------------------
    def refresh_dataset(self, dataset_code: str) -> dict[str, Any]:
        """手动刷新分析数据集：代次 +1 并清掉该数据集的全部旧快照。

        旧代次缓存随之失效，之后的取数必然命中新代次；正在飞行的旧请求返回后由调用方按代次丢弃。
        """
        current = self._generations.get(dataset_code, 1)
        new_generation = current + 1
        self._generations[dataset_code] = new_generation
        self._snapshot_cache = {
            key: value for key, value in self._snapshot_cache.items() if key[0] != dataset_code
        }
        self._mark_tasks_stale(dataset_code=dataset_code, generation=current)
        return {
            "dataset_code": dataset_code,
            "generation": new_generation,
            "refreshed_at": self._now(),
        }

    def current_generation(self, dataset_code: str) -> int:
        return self._generations.get(dataset_code, 1)

    # ------------------------------------------------------------------
    # 筛选轮次：记录每一轮筛选快照，结束后统一回写台账
    # ------------------------------------------------------------------
    def open_round(self, filters: dict[str, Any]) -> dict[str, Any]:
        """登记一轮筛选变化，固化本轮筛选快照。连续切换时每轮各留一条台账。"""
        self._round_seq += 1
        round_id = self._round_seq
        record = {
            "round_id": round_id,
            "filters": copy.deepcopy(filters),
            "filter_hash": snapshot_filter_hash(filters),
            "status": ROUND_OPEN,
            "opened_at": self._now(),
            "closed_at": None,
            "generations": dict(self._generations),
        }
        self._rounds[round_id] = record
        return copy.deepcopy(record)

    def close_round(self, round_id: int) -> dict[str, Any]:
        """筛选结束：关闭轮次并把该轮次关联的导出任务统一推进到完成态。"""
        record = self._rounds.get(round_id)
        if record is None:
            raise KeyError(f"筛选轮次 {round_id} 不存在")
        record["status"] = ROUND_CLOSED
        record["closed_at"] = self._now()
        for task in self._tasks.values():
            if task.get("round_id") == round_id and task["result_status"] in (TASK_PENDING, TASK_RUNNING):
                task["result_status"] = TASK_DONE
                task["finished_at"] = self._now()
        return copy.deepcopy(record)

    def list_rounds(self) -> list[dict[str, Any]]:
        return [copy.deepcopy(record) for record in self._rounds.values()]

    # ------------------------------------------------------------------
    # 导出任务台账：记录图表快照，结果状态与图表配置同步
    # ------------------------------------------------------------------
    def create_export_task(
        self,
        *,
        chart_id: int,
        filters: dict[str, Any],
        round_id: int | None,
    ) -> dict[str, Any]:
        """登记导出任务，台账里固化创建时刻的图表配置快照与数据快照版本。"""
        chart = self._find_chart(chart_id)
        if chart is None:
            raise KeyError(f"图表配置 {chart_id} 不存在")
        dataset_code = chart["dataset_code"]
        generation = self.current_generation(dataset_code)
        self._task_seq += 1
        task_id = self._task_seq
        task = {
            "task_id": task_id,
            "chart_id": chart_id,
            "图表编号": chart["图表编号"],
            "图表名称": chart["图表名称"],
            "dataset_code": dataset_code,
            "filters": copy.deepcopy(filters),
            "filter_hash": snapshot_filter_hash(filters),
            "round_id": round_id,
            "generation": generation,
            "chart_status": chart["status"],
            "result_status": TASK_RUNNING if round_id else TASK_PENDING,
            "created_at": self._now(),
            "finished_at": None,
        }
        self._tasks[task_id] = task
        return copy.deepcopy(task)

    def list_export_tasks(self, *, chart_id: int | None = None) -> list[dict[str, Any]]:
        tasks = list(self._tasks.values())
        if chart_id is not None:
            tasks = [task for task in tasks if task["chart_id"] == chart_id]
        return [copy.deepcopy(task) for task in tasks]

    def sync_chart_status(self, chart_id: int, chart_status: str) -> None:
        """图表配置状态变化时，同步更新台账里关联任务的结果状态。"""
        for task in self._tasks.values():
            if task["chart_id"] != chart_id:
                continue
            task["chart_status"] = chart_status
            if chart_status == "已停用":
                task["result_status"] = TASK_DISABLED
            elif chart_status == "已启用" and task["result_status"] == TASK_DISABLED:
                task["result_status"] = TASK_DONE

    def _mark_tasks_stale(self, *, dataset_code: str, generation: int) -> dict[str, Any]:
        """数据集刷新出新代次后，旧代次上的台账任务标记为已过期。"""
        for task in self._tasks.values():
            if (
                task["dataset_code"] == dataset_code
                and task["generation"] <= generation
                and task["result_status"] not in (TASK_DISABLED,)
            ):
                task["result_status"] = TASK_STALE
        return {"dataset_code": dataset_code, "generation": generation}

    # ------------------------------------------------------------------
    # 联动取数：单飞合并 + 快照缓存 + 代次校验
    # ------------------------------------------------------------------
    async def fetch_chart_data(
        self,
        *,
        chart_id: int,
        filters: dict[str, Any],
        expected_generation: int | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        """按图表配置取数。

        同一轮筛选里两张图表共用同一数据集快照时，第二次调用直接复用缓存或挂到单飞协程上，
        不会重复请求完整数据。``force=True`` 保留手动刷新语义：先推进代次再取数。
        """
        chart = self._find_chart(chart_id)
        if chart is None:
            raise KeyError(f"图表配置 {chart_id} 不存在")
        dataset_code = chart["dataset_code"]

        if force:
            self.refresh_dataset(dataset_code)
        generation = self.current_generation(dataset_code)
        filter_hash = snapshot_filter_hash(filters)
        cache_key = (dataset_code, generation, filter_hash)

        snapshot = await self._load_snapshot(cache_key, dataset_code, generation, filters, force=False)
        series = self._project_series(chart, snapshot, filters)
        stale = expected_generation is not None and generation != expected_generation
        return {
            "chart_id": chart_id,
            "图表编号": chart["图表编号"],
            "图表名称": chart["图表名称"],
            "dataset_code": dataset_code,
            "generation": generation,
            "expected_generation": expected_generation,
            "stale": stale,
            "filter_hash": filter_hash,
            "filters": copy.deepcopy(filters),
            "cached": snapshot.get("_cache_hit", False),
            "fetched_at": self._now(),
            "series": series,
        }

    async def fetch_round(
        self,
        *,
        filters: dict[str, Any],
        expected_generations: dict[str, int] | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        """一轮筛选的合并取数：每个数据集快照只取一次，所有可见图表并发挂载到同一份快照上。

        返回每张图表的渲染数据与代次信息；过期图表会带上 ``stale=True``，由前端丢弃旧结果。
        """
        charts = [chart for chart in self.linkage_charts() if chart["status"] != "已停用"]
        expected = expected_generations or {}
        results = await asyncio.gather(*[
            self.fetch_chart_data(
                chart_id=chart["chart_id"],
                filters=filters,
                expected_generation=expected.get(chart["dataset_code"]),
                force=False,
            )
            for chart in charts
        ])
        generations = {item["dataset_code"]: item["generation"] for item in results}
        return {
            "filters": copy.deepcopy(filters),
            "filter_hash": snapshot_filter_hash(filters),
            "generations": generations,
            "forced": force,
            "charts": list(results),
            "fetch_count": self.fetch_count,
        }

    async def _load_snapshot(
        self,
        cache_key: tuple[str, int, str],
        dataset_code: str,
        generation: int,
        filters: dict[str, Any],
        *,
        force: bool,
    ) -> dict[str, Any]:
        """快照三级处理：命中缓存直接返回；命中单飞就等待；否则发起唯一一次实际取数。"""
        if not force and cache_key in self._snapshot_cache:
            snapshot = copy.deepcopy(self._snapshot_cache[cache_key])
            snapshot["_cache_hit"] = True
            return snapshot

        inflight = self._inflight.get(cache_key)
        if inflight is not None:
            snapshot = await inflight
            return copy.deepcopy(snapshot)

        future: asyncio.Future[dict[str, Any]] = asyncio.get_event_loop().create_future()
        self._inflight[cache_key] = future
        try:
            snapshot = await self._build_snapshot(dataset_code, generation, filters)
            self._snapshot_cache[cache_key] = copy.deepcopy(snapshot)
            future.set_result(snapshot)
        except BaseException as exc:  # 单飞失败要唤醒所有等待方，避免请求悬挂
            future.set_exception(exc)
            raise
        finally:
            self._inflight.pop(cache_key, None)
        return copy.deepcopy(snapshot)

    async def _build_snapshot(
        self, dataset_code: str, generation: int, filters: dict[str, Any]
    ) -> dict[str, Any]:
        """模拟一次完整数据集取数：带 IO 延迟，代次与筛选快照都会体现在数据里。"""
        self.fetch_count += 1
        await asyncio.sleep(SNAPSHOT_LATENCY_SECONDS)
        region = str(filters.get("地区") or "全部")
        rows = []
        for index, region_name in enumerate(REGION_VALUES[1:], start=1):
            if region != "全部" and region_name != region:
                continue
            # 代次进入数据本身：刷新后同一筛选也会得到不同快照，便于验证新代次命中。
            base = generation * 100 + index * 10
            rows.append({
                "地区": region_name,
                "统计日期": f"2026-11-{10 + index:02d}",
                "销售额": base + 7,
                "订单数": base + 3,
                "客单价": base + 1,
                "客户数": base + 5,
                "转化率": round(0.2 + index * 0.07 + generation * 0.01, 4),
            })
        return {
            "dataset_code": dataset_code,
            "generation": generation,
            "filter_hash": snapshot_filter_hash(filters),
            "rows": rows,
            "built_at": self._now(),
            "_cache_hit": False,
        }

    # ------------------------------------------------------------------
    # 图表投影与内部工具
    # ------------------------------------------------------------------
    def _project_series(
        self, chart: dict[str, Any], snapshot: dict[str, Any], filters: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """按图表配置（横轴/纵轴字段）从数据集快照投影出渲染序列。"""
        x_field = chart.get("横轴字段") or "地区"
        y_field = chart.get("纵轴字段") or "销售额"
        series = []
        for row in snapshot.get("rows", []):
            series.append({
                "x": row.get(x_field, x_field),
                "y": row.get(y_field, 0),
                "x_field": x_field,
                "y_field": y_field,
            })
        return series

    def _find_chart(self, chart_id: int) -> dict[str, Any] | None:
        for chart in self.linkage_charts():
            if chart["chart_id"] == chart_id:
                return chart
        return None

    @staticmethod
    def _to_int(value: Any, *, default: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _now() -> str:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


# 进程内单例：路由与图表状态流转共用同一份联动状态。
linkage_service = LinkageService()
