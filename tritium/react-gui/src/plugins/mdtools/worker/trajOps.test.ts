/**
 * Contract test for the ops a plugin adds to the catalogue (trajOps.ts,
 * `registerPluginOps`).
 *
 * Pinned: ops registered after the native console and the AI agent's tool
 * module have loaded (the worker globs services in that order) still reach
 * every caller -- the native console's commands, MCP's tool list, the agent's
 * `md` toolset and `findOp` -- and a second op of the same name is refused.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@cuemol/core/src/wrappers/wrapper-loader', () => ({ wrapper_map: {} }))

// Loaded before the plugin registers its ops, as in the worker.
import { NATIVE_DIALECT } from '@plugins/console/worker/dialects/native'
import { allAgentTools, toolsetsEnabledIn } from '@plugins/agent/worker/tools/index'
import { findOp, mcpOps, registerPluginOps } from '@renderer/worker/server/catalog'
import { TRAJ_OPS } from './trajOps'
import './mdtools.service'

const NAMES = TRAJ_OPS.map((op) => op.name)

describe('plugin ops', () => {
  it('reach the native console, MCP, the agent toolset and findOp after the modules loaded', () => {
    const commands = new Set(NATIVE_DIALECT.commands().map((c) => c.name))
    const mcp = new Set(mcpOps().map((op) => op.name))
    const agent = new Set(allAgentTools().map((t) => t.name))
    for (const name of NAMES) {
      expect(commands.has(name)).toBe(true)
      expect(mcp.has(name)).toBe(true)
      expect(agent.has(name)).toBe(true)
      expect(findOp(name)?.name).toBe(name)
    }
    // The md toolset is one the agent can switch on.
    const history = [{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'enable_toolsets', input: { toolsets: ['md'] } }] }]
    expect(toolsetsEnabledIn(history as never).has('md')).toBe(true)
  })

  it('refuses an op whose name is already in the catalogue', () => {
    expect(() => registerPluginOps('other', [TRAJ_OPS[0]])).toThrow(/already in the catalogue/)
  })
})
