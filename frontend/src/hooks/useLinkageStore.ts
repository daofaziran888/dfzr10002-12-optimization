import { useSyncExternalStore } from 'react'

import { linkageStore } from '@/stores/linkage'

/**
 * 订阅联动 store：store 任意状态变更都会触发组件重绘，
 * 但取数结果只在筛选结束时一次性提交，渲染次数与取数轮次对齐。
 */
export function useLinkageStore() {
  useSyncExternalStore(linkageStore.subscribe, () => linkageStore.version)
  return linkageStore
}
