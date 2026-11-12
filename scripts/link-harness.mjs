/** Link already-built sibling packages for offline development; never write to the Harness. */
import { readFile, mkdir, symlink, lstat, readlink, rm } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = resolve(process.argv[2] ?? resolve(root, '../../deepseek-harness'))
async function link(source, destination) {
  await mkdir(dirname(destination), { recursive: true })
  try {
    const stats = await lstat(destination)
    if (stats.isSymbolicLink() && resolve(dirname(destination), await readlink(destination)) === source) {
      console.log(`Keep existing ${destination}`)
      return
    }
    // Replace a stale link, or a real copy left by `npm install`, so `tsc` cannot crawl package sources.
    await rm(destination, { recursive: true, force: true })
    console.log(`Replace stale ${destination}`)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await symlink(source, destination, 'dir')
}
const locations = {
  '@deepseek-ai/cordis': 'vendor/cordis', '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-agent': 'packages/core/agent', '@deepseek-ai/dsh-commands': 'packages/interaction/commands',
  '@deepseek-ai/dsh-compaction': 'packages/compaction/compaction', '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-session': 'packages/core/session', '@deepseek-ai/dsh-session-projection': 'packages/session/session-projection',
  '@deepseek-ai/dsh-token-meter': 'packages/llm/token-meter',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt', '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-tool-executor-native': 'packages/core/tool-executor-native', '@deepseek-ai/dsh-agent-loop': 'packages/core/agent-loop',
  '@deepseek-ai/dsh-session-persistence': 'packages/session/session-persistence',
  '@deepseek-ai/dsh-session-persistence-jsonl': 'packages/session/session-persistence-jsonl',
  typescript: 'node_modules/typescript', zod: 'node_modules/zod', '@types/node': 'node_modules/@types/node',
}
await readFile(resolve(harness, 'package.json'), 'utf8')
for (const [name, location] of Object.entries(locations)) {
  const destination = resolve(root, 'node_modules', name)
  const source = resolve(harness, location)
  await readFile(resolve(source, 'package.json'), 'utf8')
  await link(source, resolve(root, 'node_modules', name))
}
await link(resolve(harness, 'node_modules/typescript/bin/tsc'), resolve(root, 'node_modules/.bin/tsc'))
console.log(`Linked development dependencies from ${harness}; Harness files unchanged.`)
