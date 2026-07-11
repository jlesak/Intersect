import { usePrInboxStore } from '../store'
import { PrBoard } from './PrBoard'
import { PrDetail } from './PrDetail'

/** PR Review main area: the board, or the selected PR's detail. */
export function PrInboxView() {
  const view = usePrInboxStore((s) => s.view)
  return view === 'board' ? <PrBoard /> : <PrDetail />
}
