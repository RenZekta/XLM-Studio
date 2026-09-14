// The "transport layer": exposes mcpControl.ts's tools two ways —
//   1. A real MCP protocol server (Streamable HTTP transport), for any
//      MCP-capable client (Claude Desktop, Claude Code, etc.) to connect to.
//   2. A plain JSON control API on the same HTTP server, used by the
//      generated skill's CLI scripts (see skillGenerator.ts) instead of
//      speaking the MCP protocol.
// Both are bound to 127.0.0.1 only and require the per-install bearer token
// from Settings — see McpSettings.token.
import { ipcMain } from 'electron'
import http, { IncomingMessage, ServerResponse } from 'http'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpSettings } from '../shared/types'
import { MCP_TOOL_IDS } from '../shared/types'
import { initControlLayer, TOOL_DEFS, type ControlDeps } from './mcpControl'
import { writeSkillFiles, removeSkillFiles } from './skillGenerator'

let httpServer: http.Server | null = null
let currentSettings: McpSettings | null = null
let saveSettingsFn: ((s: any) => Promise<void>) | null = null
let loadFullSettingsFn: (() => Promise<any>) | null = null

// A minimal JSON-schema-ish "any object" param shape, converted to zod at
// registration time. Every tool's params are declared as a flat object of
// simple types (string / number / string[] / object / enum-ish literal
// unions expressed as strings) in mcpControl.ts's TOOL_DEFS — build() below
// turns that into a real zod shape.
function zodShapeFor(params: { name: string; type: string; required: boolean; description: string }[]) {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const p of params) {
    let field: z.ZodTypeAny
    if (p.type.includes('[]')) field = z.array(z.any()).describe(p.description)
    else if (p.type === 'number') field = z.number().describe(p.description)
    else if (p.type === 'object') field = z.record(z.any()).describe(p.description)
    else field = z.union([z.string(), z.number()]).describe(p.description)
    shape[p.name] = p.required ? field : field.optional()
  }
  return shape
}

function buildMcpServer(enabledTools: Record<string, boolean>): McpServer {
  const server = new McpServer({ name: 'xlm-studio', version: '1.0.0' })
  for (const tool of TOOL_DEFS) {
    if (enabledTools[tool.name] === false) continue
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: zodShapeFor(tool.params) },
      async (args: any) => {
        try {
          const result = await tool.handler(args || {})
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `Error: ${err?.message || String(err)}` }], isError: true }
        }
      }
    )
  }
  return server
}

function checkToken(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization']
  const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-xlm-token'] as string | undefined)
  return provided === token
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

async function handleControlApi(req: IncomingMessage, res: ServerResponse, settings: McpSettings) {
  // POST /control/<tool-name>  { ...args }  ->  200 JSON result | 4xx/5xx { error }
  const toolName = (req.url || '').replace(/^\/control\//, '').replace(/\/$/, '')
  const tool = TOOL_DEFS.find(t => t.name === toolName)
  if (!tool) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Unknown tool "${toolName}"` }))
    return
  }
  if (settings.tools[toolName as typeof MCP_TOOL_IDS[number]] === false) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Tool "${toolName}" is disabled in Settings -> MCP Server.` }))
    return
  }
  try {
    const bodyRaw = await readBody(req)
    const args = bodyRaw ? JSON.parse(bodyRaw) : {}
    const result = await tool.handler(args)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err: any) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err?.message || String(err) }))
  }
}

async function startServer(settings: McpSettings) {
  await stopServer()
  if (!settings.enabled) return

  const mcpTransportEnabled = !settings.skillMode

  httpServer = http.createServer(async (req, res) => {
    try {
      if (!checkToken(req, settings.token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing or invalid token' }))
        return
      }
      if ((req.url || '').startsWith('/control/')) {
        await handleControlApi(req, res, settings)
        return
      }
      if (mcpTransportEnabled && (req.url === '/mcp' || (req.url || '').startsWith('/mcp'))) {
        // Per the MCP SDK's own documented stateless pattern (see
        // examples/server/simpleStatelessStreamableHttp.ts): a fresh
        // McpServer + transport is created for EVERY request and torn down
        // once the response closes. Reusing one transport across multiple
        // requests breaks after the first call.
        const server = buildMcpServer(settings.tools)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        await server.connect(transport)
        const bodyRaw = ['POST', 'PUT', 'PATCH'].includes(req.method || '') ? await readBody(req) : undefined
        const parsedBody = bodyRaw ? JSON.parse(bodyRaw) : undefined
        res.on('close', () => { transport.close(); server.close() })
        await transport.handleRequest(req, res, parsedBody)
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    } catch (err: any) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err?.message || String(err) }))
    }
  })
  // 127.0.0.1 only — never 0.0.0.0. This is a lifecycle-control surface
  // (can start/stop processes, edit/create Templates), so it must never be
  // reachable from the local network, regardless of Base URL Override's own
  // "Serve on local network" setting (that's an unrelated, model-inference-
  // only switch).
  // Tool calls like template-action/switch-template/benchmark can legitimately
  // block for minutes (waiting for a large model to finish loading) — make
  // sure Node's own idle/request timeouts don't kill that connection out
  // from under a slow-but-healthy tool call.
  httpServer.timeout = 0
  httpServer.requestTimeout = 0
  httpServer.keepAliveTimeout = 15 * 60 * 1000
  httpServer.listen(settings.port, '127.0.0.1')
}

async function stopServer() {
  if (httpServer) {
    await new Promise<void>(resolve => httpServer!.close(() => resolve()))
    httpServer = null
  }
}

export async function initMcpLayer(_appRoot: string, deps: ControlDeps & {
  loadFullSettings: () => Promise<any>
  saveFullSettings: (s: any) => Promise<void>
}) {
  initControlLayer(deps)
  loadFullSettingsFn = deps.loadFullSettings
  saveSettingsFn = deps.saveFullSettings
  const settings = await deps.loadFullSettings()
  await applyMcpSettings(settings.mcp)
}

// Called whenever mcp settings change (from the IPC handlers below, or
// programmatically). Starts/stops the HTTP server and writes/removes the
// skill files to match the new settings. The skill is removed whenever
// EITHER the whole MCP section is turned off, OR skill mode itself is
// turned back off while MCP stays on (leaving the live MCP server as the
// only active option) — not just the former.
export async function applyMcpSettings(mcp: McpSettings | undefined) {
  if (!mcp) return
  const prev = currentSettings
  currentSettings = mcp
  if (!mcp.enabled) {
    await stopServer()
    removeSkillFiles()
    return
  }
  await startServer(mcp)
  if (mcp.skillMode) {
    // Auto-(re)write on enabling skill mode, or whenever the enabled tool
    // set / restrict-edit switch changes, so the generated SKILL.md never
    // drifts from what's actually being served.
    const toolsChanged = !prev || JSON.stringify(prev.tools) !== JSON.stringify(mcp.tools) || prev.restrictEditToMcpMade !== mcp.restrictEditToMcpMade || prev.port !== mcp.port || prev.token !== mcp.token || !prev.skillMode
    if (toolsChanged) writeSkillFiles(mcp)
  } else if (prev?.skillMode && !mcp.skillMode) {
    // Left skill mode for the live-server-only mode.
    removeSkillFiles()
  }
}

export async function shutdownMcpLayer() {
  await stopServer()
}

export function registerMcpHandlers() {
  ipcMain.handle('get-mcp-settings', async () => {
    const s = await loadFullSettingsFn!()
    return s.mcp
  })
  ipcMain.handle('set-mcp-settings', async (_e, mcp: McpSettings) => {
    const s = await loadFullSettingsFn!()
    s.mcp = mcp
    await saveSettingsFn!(s)
    await applyMcpSettings(mcp)
    return { success: true }
  })
  ipcMain.handle('add-skill-files', async () => {
    const s = await loadFullSettingsFn!()
    if (!s.mcp?.enabled) return { success: false, error: 'Turn on MCP Server first.' }
    writeSkillFiles(s.mcp)
    return { success: true }
  })
  ipcMain.handle('remove-skill-files', async () => {
    removeSkillFiles()
    return { success: true }
  })
}
