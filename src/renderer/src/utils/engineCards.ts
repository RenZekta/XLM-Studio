import { registerCardEngines } from '../../../shared/engines'
import { cardToEngineDef, type EngineCard, type EngineCardInfo } from '../../../shared/engineCard'

// Makes the loaded cards known to the renderer's engine registry. A custom
// card follows a built-in one in the list and takes its place by id.
export async function loadEngineCards(): Promise<EngineCardInfo[]> {
  const infos = await window.api.getEngineCards()
  const byId = new Map<string, EngineCard>()
  for (const info of infos) if (info.card) byId.set(info.card.id, info.card)
  registerCardEngines(Array.from(byId.values(), cardToEngineDef))
  return infos
}
