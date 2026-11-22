import { useMemo } from 'react'
import { useStore } from '../store/useStore'
import { buildModelContext, buildSystemContext, emptyCardContext, type CardContext } from '../../../shared/cardContext'

const PLATFORM = /win/i.test(navigator.platform) ? 'win32' : /mac/i.test(navigator.platform) ? 'darwin' : 'linux'

// The live figures a card's expressions see in the editor, built from the same
// polled hardware data and cached model metadata the rest of the app reads.
export function useCardContext(opts: {
  engine: string
  args: Record<string, unknown>
  modelPath: string
  templateName: string
  port: number
  host?: string | null
  apiKeySet?: boolean
}): CardContext {
  const { vramInfo, systemRam, cpuInfo, ggufMetadata, engineOverrides } = useStore()
  const meta = opts.modelPath ? ggufMetadata[opts.modelPath] : null
  const fields = engineOverrides[opts.engine]
  return useMemo(() => ({
    ...emptyCardContext(PLATFORM),
    system: buildSystemContext(PLATFORM, systemRam, vramInfo as any, cpuInfo),
    model: buildModelContext(opts.modelPath, meta),
    args: opts.args,
    overrides: { port: opts.port, host: opts.host ?? null, apiKeySet: !!opts.apiKeySet, engine: fields ?? {} },
    template: { name: opts.templateName, port: opts.port }
  }), [vramInfo, systemRam, cpuInfo, meta, fields, opts.args, opts.modelPath, opts.templateName, opts.port, opts.host, opts.apiKeySet])
}
