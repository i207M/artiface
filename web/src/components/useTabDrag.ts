import type { RefObject } from 'react'
import { tabKey } from './workspaceTabs'
import type { OpenFile } from './workspaceTabs'
import { useReorderDrag } from './useReorderDrag'

export function useTabDrag(list: RefObject<HTMLDivElement | null>, tabs: OpenFile[], selection: string,
  onReorder: (tab: OpenFile, target: OpenFile, edge: 'before' | 'after') => void) {
  return useReorderDrag(list, tabs, selection, onReorder, {
    key: tabKey, attribute: 'data-tab-key', image: '.reader-tab',
    transferType: 'application/x-artiface-tab', axis: 'horizontal',
  })
}
