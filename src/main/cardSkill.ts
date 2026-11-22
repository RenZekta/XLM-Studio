// The skill that teaches an agent to write an engine card for XLM Studio.
// Separate from the control skill (skillGenerator.ts): that one drives the
// running app, this one needs no MCP and no running app. It is written to
//   <home>/.agents/skills/xlm-studio-engine-card/
// as SKILL.md (the repository's instructions plus this machine's folders),
// guide.md, check-card.cjs and examples/. The files come from the repository's
// docs, so what an agent reads installed is what the repository holds.
// Plain Node, so it can be tested without Electron.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const CARD_SKILL_NAME = 'xlm-studio-engine-card'

export function cardSkillDir(home: string = homedir()): string {
  return join(home, '.agents', 'skills', CARD_SKILL_NAME)
}

export interface CardSkillSources {
  // docs/engine-card-skill (SKILL.md, check-card.cjs, examples/)
  skillSourceDir: string
  // docs/engine-cards.md
  guidePath: string
}

export interface CardSkillMachine {
  cardsDir: string
  enginesDir: string
  platform: string
}

// SKILL.md of the repository with a section naming this machine's folders after
// its front matter, so an agent does not have to ask where things go.
export function buildCardSkillMd(source: string, machine: CardSkillMachine, skillDir: string): string {
  const os = machine.platform === 'win32' ? 'Windows' : machine.platform === 'darwin' ? 'macOS' : 'Linux'
  const section = [
    '## This machine',
    '',
    `- System: ${os}. Run the checker with Node: \`node "${join(skillDir, 'check-card.cjs')}" <card.json>\`.`,
    `- Save finished cards in: \`${machine.cardsDir}\` (as \`<id>.json\`).`,
    `- Engines live in: \`${machine.enginesDir}\` (\`<engine.folder>/\`). A card with \`source\`/\`install\` lets XLM Studio create the engine's folder itself (Settings > Engine Cards > Install).`,
    `- Cards already there are the best examples of what works: list that folder before writing yours, and do not reuse an id.`,
    ''
  ].join('\n')
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source)
  if (!m) return `${section}\n${source}`
  return `${m[0]}\n${section}${source.slice(m[0].length)}`
}

export function writeCardSkill(sources: CardSkillSources, machine: CardSkillMachine, home?: string): { success: boolean; dir: string; error?: string } {
  const dir = cardSkillDir(home)
  try {
    const skillMd = join(sources.skillSourceDir, 'SKILL.md')
    const checker = join(sources.skillSourceDir, 'check-card.cjs')
    for (const f of [skillMd, checker, sources.guidePath]) {
      if (!existsSync(f)) return { success: false, dir, error: `${f} was not found in this install.` }
    }
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, 'examples'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), buildCardSkillMd(readFileSync(skillMd, 'utf-8'), machine, dir))
    copyFileSync(sources.guidePath, join(dir, 'guide.md'))
    copyFileSync(checker, join(dir, 'check-card.cjs'))
    const examples = join(sources.skillSourceDir, 'examples')
    if (existsSync(examples)) for (const f of readdirSync(examples)) copyFileSync(join(examples, f), join(dir, 'examples', f))
    return { success: true, dir }
  } catch (err) {
    return { success: false, dir, error: err instanceof Error ? err.message : String(err) }
  }
}

export function removeCardSkill(home?: string): void {
  try { rmSync(cardSkillDir(home), { recursive: true, force: true }) } catch (err) { console.error('[cardSkill] Failed to remove skill files:', err) }
}

export function cardSkillInstalled(home?: string): boolean {
  return existsSync(join(cardSkillDir(home), 'SKILL.md'))
}
