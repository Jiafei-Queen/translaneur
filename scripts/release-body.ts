import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const INSTALLATION = `### Installation

- **Firefox**: Drag and drop \`translaneur-<version>-firefox.xpi\` onto the browser window. The build is AMO-signed and installs permanently.
- **Google Chrome / Edge**: Due to recent Chrome security policies, direct installation of \`.crx\` files is no longer supported.
  1. Download \`translaneur-<version>-chrome.zip\`.
  2. Extract the ZIP file to a local folder.
  3. Open \`chrome://extensions/\`, enable **Developer mode** (top right), and click **Load unpacked** (or drag and drop the extracted folder) to install.
- **Thunderbird**: In Add-ons and Themes, choose **Install Add-on From File…** and select \`translaneur-<version>-thunderbird.xpi\`.`

export function extractSection(markdown: string, version: string): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no "## [${version}]" section`)
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n').trim()
}

export function buildReleaseBody(markdown: string, version: string): string {
  const section = extractSection(markdown, version).replace(/^(#{3,}) /gm, '$1# ')
  return `### What's New\n\n${section}\n\n${INSTALLATION}`
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  const version = process.argv[2]
  if (!version) {
    console.error('usage: node scripts/release-body.ts <version>')
    process.exit(1)
  }
  const changelogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md')
  try {
    process.stdout.write(buildReleaseBody(readFileSync(changelogPath, 'utf8'), version))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
