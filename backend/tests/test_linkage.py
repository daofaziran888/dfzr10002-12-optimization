"""联动服务核心规则测试：只依赖标准库，直接 ``python3 -I tests/test_linkage.py`` 运行。

覆盖：
1. 同一轮筛选多张图表共用数据集快照时只取一次数（单飞 + 缓存复用）；
2. 快速连续切换时只有最后一次选择生效，旧代次响应被标记 stale 丢弃；
3. 手动刷新推进代次并淘汰旧快照，新取数命中新代次；
4. 筛选轮次记录筛选快照，结束后统一回写导出任务结果状态；
5. 图表配置停用后导出台账结果状态同步；
6. 图表列表按图表编号检索、按刷新间隔排序、筛选与分页同时生效。
"""
from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.chart import ChartService  # noqa: E402
from app.services.linkage import (  # noqa: E402
    TASK_DISABLED,
    TASK_DONE,
    TASK_RUNNING,
    LinkageService,
    snapshot_filter_hash,
)


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def fresh_service() -> LinkageService:
    return LinkageService()


def test_single_flight_shared_snapshot() -> None:
    """两张图表共用同一数据集 + 同一筛选快照：并发取数只允许一次实际取数。"""
    service = fresh_service()
    charts = service.linkage_charts()
    shared = [chart for chart in charts if chart["dataset_code"] == "DATA-0001"]
    assert len(shared) >= 2, "种子数据里 DATA-0001 至少要挂两张图表"

    async def scenario() -> None:
        filters = {"地区": "华东"}
        results = await asyncio.gather(*[
            service.fetch_chart_data(chart_id=chart["chart_id"], filters=filters)
            for chart in shared
        ])
        assert service.fetch_count == 1, f"同快照并发应只取一次数，实际 {service.fetch_count} 次"
        generations = {item["generation"] for item in results}
        assert generations == {1}
        # 第二次同轮取数应直接命中缓存。
        again = await service.fetch_chart_data(chart_id=shared[0]["chart_id"], filters=filters)
        assert service.fetch_count == 1
        assert again["cached"] is True
        # 不同筛选快照是另一份缓存，需要重新取数。
        other = await service.fetch_chart_data(chart_id=shared[0]["chart_id"], filters={"地区": "华北"})
        assert service.fetch_count == 2
        assert other["filter_hash"] != again["filter_hash"]

    run(scenario())
    print("ok test_single_flight_shared_snapshot")


def test_last_selection_wins_stale_generation() -> None:
    """模拟华东→华南→华北快速切换 + 手动刷新：旧响应必须带 stale，不能覆盖新结果。"""
    service = fresh_service()
    chart_id = service.linkage_charts()[0]["chart_id"]

    async def scenario() -> None:
        # 第一次取数时客户端只知道代次 1。
        first = await service.fetch_chart_data(
            chart_id=chart_id, filters={"地区": "华东"}, expected_generation=1
        )
        assert first["stale"] is False

        # 数据集在途期间被手动刷新，代次推进到 2。
        service.refresh_dataset(first["dataset_code"])
        assert service.current_generation(first["dataset_code"]) == 2

        # 旧请求（仍按代次 1 期望）返回：服务端识别为过期，前端应丢弃。
        stale = await service.fetch_chart_data(
            chart_id=chart_id, filters={"地区": "华东"}, expected_generation=1
        )
        assert stale["generation"] == 2
        assert stale["stale"] is True

        # 最后一次选择（华北）按最新代次取数，才允许上屏。
        latest = await service.fetch_chart_data(
            chart_id=chart_id, filters={"地区": "华北"}, expected_generation=2
        )
        assert latest["stale"] is False
        assert latest["filters"] == {"地区": "华北"}
        # 投影后的序列行数等于快照里华北的行数，证明筛选口径确实是最后一次选择。
        assert len(latest["series"]) == 1

    run(scenario())
    print("ok test_last_selection_wins_stale_generation")


def test_manual_refresh_bumps_generation_and_clears_cache() -> None:
    """手动刷新后旧快照失效，同样的筛选也要重新取数并命中新代次。"""
    service = fresh_service()
    chart = service.linkage_charts()[0]

    async def scenario() -> None:
        before = await service.fetch_chart_data(
            chart_id=chart["chart_id"], filters={"地区": "全部"}
        )
        assert before["generation"] == 1
        cached = await service.fetch_chart_data(
            chart_id=chart["chart_id"], filters={"地区": "全部"}
        )
        assert cached["cached"] is True

        refreshed = await service.fetch_chart_data(
            chart_id=chart["chart_id"], filters={"地区": "全部"}, force=True
        )
        assert refreshed["generation"] == 2
        assert refreshed["cached"] is False
        # 数据体随代次变化，证明拿到的是新代次快照。
        assert refreshed["series"] != before["series"]

    run(scenario())
    print("ok test_manual_refresh_bumps_generation_and_clears_cache")


def test_round_snapshot_and_export_ledger() -> None:
    """筛选轮次固化快照；轮次结束后关联导出任务统一完成；数据集刷新使旧任务过期。"""
    service = fresh_service()
    chart_id = service.linkage_charts()[0]["chart_id"]
    filters = {"地区": "华南"}

    round_record = service.open_round(filters)
    assert round_record["filter_hash"] == snapshot_filter_hash(filters)
    assert round_record["status"] == "进行中"

    task = service.create_export_task(
        chart_id=chart_id, filters=filters, round_id=round_record["round_id"]
    )
    assert task["result_status"] == TASK_RUNNING
    assert task["generation"] == 1
    assert task["filters"] == filters

    closed = service.close_round(round_record["round_id"])
    assert closed["status"] == "已结束"
    tasks = service.list_export_tasks(chart_id=chart_id)
    assert tasks[0]["result_status"] == TASK_DONE

    # 数据集刷新出新一代次，旧代次任务标记过期。
    service.refresh_dataset(task["dataset_code"])
    assert service.list_export_tasks(chart_id=chart_id)[0]["result_status"] == "已过期"
    print("ok test_round_snapshot_and_export_ledger")


def test_chart_status_syncs_ledger() -> None:
    """图表配置停用/启用后，导出任务台账结果状态跟着同步。"""
    service = fresh_service()
    chart_id = service.linkage_charts()[0]["chart_id"]
    task = service.create_export_task(
        chart_id=chart_id, filters={"地区": "华中"}, round_id=None
    )
    assert task["result_status"] == "待生成"

    service.sync_chart_status(chart_id, "已停用")
    assert service.list_export_tasks(chart_id=chart_id)[0]["result_status"] == TASK_DISABLED

    service.sync_chart_status(chart_id, "已启用")
    assert service.list_export_tasks(chart_id=chart_id)[0]["result_status"] == TASK_DONE
    print("ok test_chart_status_syncs_ledger")


def test_chart_list_search_sort_paginate() -> None:
    """图表配置列表：编号检索 + 刷新间隔排序 + 状态过滤，分页在过滤排序之后生效。"""
    chart_service = ChartService()
    items, total = chart_service.list_entries(keyword="CHAR-000", page=1, size=2)
    assert total == 6
    assert len(items) == 2

    asc, _ = chart_service.list_entries(sort_by="刷新间隔", order="asc", page=1, size=10)
    intervals = [int(row["刷新间隔"]) for row in asc]
    assert intervals == sorted(intervals)
    assert intervals[0] == 15 and intervals[-1] == 120

    desc, _ = chart_service.list_entries(sort_by="刷新间隔", order="desc", page=1, size=10)
    assert [int(row["刷新间隔"]) for row in desc] == list(reversed(intervals))

    enabled, enabled_total = chart_service.list_entries(status="已启用", page=1, size=10)
    assert enabled_total == 3
    assert all(row["status"] == "已启用" for row in enabled)

    # 筛选条件与分页范围同时生效：关键词过滤后再分页定位。
    page_one, page_total = chart_service.list_entries(keyword="CHAR-000", page=1, size=3)
    page_two, _ = chart_service.list_entries(keyword="CHAR-000", page=2, size=3)
    assert page_total == 6
    assert {row["id"] for row in page_one}.isdisjoint({row["id"] for row in page_two})
    print("ok test_chart_list_search_sort_paginate")


def test_fetch_round_groups_by_dataset() -> None:
    """整轮合并取数：两个数据集各取一次，全部图表共享各自数据集的快照。"""
    service = fresh_service()

    async def scenario() -> None:
        result = await service.fetch_round(filters={"地区": "西南"})
        dataset_codes = {chart["dataset_code"] for chart in service.linkage_charts()
                         if chart["status"] != "已停用"}
        assert service.fetch_count == len(dataset_codes)
        assert len(result["charts"]) == sum(
            1 for chart in service.linkage_charts() if chart["status"] != "已停用"
        )
        assert result["filter_hash"] == snapshot_filter_hash({"地区": "西南"})

    run(scenario())
    print("ok test_fetch_round_groups_by_dataset")


if __name__ == "__main__":
    test_single_flight_shared_snapshot()
    test_last_selection_wins_stale_generation()
    test_manual_refresh_bumps_generation_and_clears_cache()
    test_round_snapshot_and_export_ledger()
    test_chart_status_syncs_ledger()
    test_chart_list_search_sort_paginate()
    test_fetch_round_groups_by_dataset()
    print("all linkage tests passed")
