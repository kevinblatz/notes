/**
 * Writes src/shared/words/en-US.txt, the word list behind the app's own spelling checker.
 *
 * The words come from the npm package wordlist-english 1.2.1 (MIT), which packages SCOWL
 * (Spell Checker Oriented Word Lists, Kevin Atkinson; permissive licence, see
 * resources/licenses/wordlist-english.txt). It is not a dependency of the app: fetch it once
 * into a scratch folder and point this script at it.
 *
 *   npm pack wordlist-english@1.2.1 && tar -xzf wordlist-english-1.2.1.tgz
 *   node scripts/make-wordlist.mjs ./package
 *
 * SCOWL sorts words by how common they are: level 10 holds the most common ones, 60 is the
 * size most spelling dictionaries ship (en_US in Hunspell). Levels above 60 add many rare
 * words that would hide real typos, so they are left out.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const LEVELS = [10, 20, 35, 40, 50, 55, 60]
const DIALECTS = ['english', 'american']

const source = process.argv[2]
if (!source) {
  console.error('Usage: node scripts/make-wordlist.mjs <path to the extracted wordlist-english package>')
  process.exit(1)
}
const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version

const levelOf = new Map()
for (const level of LEVELS) {
  for (const dialect of DIALECTS) {
    const words = JSON.parse(readFileSync(join(source, `${dialect}-words-${level}.json`), 'utf8'))
    for (const word of words) if (!levelOf.has(word)) levelOf.set(word, level)
  }
}

const lines = [
  '# English (US) words for the Trading Notes spelling checker, most common first.',
  `# From wordlist-english ${version} (MIT, Jackson Ray Hamilton), which packages SCOWL by Kevin Atkinson.`,
  '# Licence and credits: resources/licenses/wordlist-english.txt. Regenerate: scripts/make-wordlist.mjs.',
  `# Levels ${LEVELS.join(', ')} of the "english" and "english/american" lists. "@NN" starts a level.`
]
for (const level of LEVELS) {
  lines.push(`@${level}`)
  const words = [...levelOf].filter(([, l]) => l === level).map(([w]) => w).sort()
  lines.push(...words)
}
const out = resolve(import.meta.dirname, '../src/shared/words/en-US.txt')
writeFileSync(out, `${lines.join('\n')}\n`)
console.log(`${levelOf.size} words -> ${out}`)
