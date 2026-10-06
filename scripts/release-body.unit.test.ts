import { describe, expect, it } from 'vitest'
import { buildReleaseBody, extractSection } from './release-body.ts'

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.3.0] - 2026-10-06

### Added
- Thunderbird support

## [0.2.4] - 2026-10-05

### Fixed
- Clip lifting
`

describe('extractSection', () => {
  it('slices the version section without its heading', () => {
    expect(extractSection(CHANGELOG, '0.3.0')).toBe('### Added\n- Thunderbird support')
  })

  it('stops at the next version heading', () => {
    expect(extractSection(CHANGELOG, '0.2.4')).toBe('### Fixed\n- Clip lifting')
  })

  it('does not treat [Unreleased] as a version heading', () => {
    expect(extractSection(CHANGELOG, '0.3.0')).not.toContain('Unreleased')
  })

  it('does not match a version prefix of another version', () => {
    expect(() => extractSection(CHANGELOG, '0.3')).toThrow('no "## [0.3]" section')
    expect(() => extractSection(CHANGELOG, '0.3.0-beta')).toThrow(
      'no "## [0.3.0-beta]" section',
    )
  })

  it('throws when the section is missing', () => {
    expect(() => extractSection(CHANGELOG, '9.9.9')).toThrow('no "## [9.9.9]" section')
  })
})

describe('buildReleaseBody', () => {
  const body = buildReleaseBody(CHANGELOG, '0.3.0')

  it('puts What\'s New before Installation', () => {
    expect(body.indexOf("### What's New")).toBeLessThan(body.indexOf('### Installation'))
  })

  it('demotes section headings so they nest under What\'s New', () => {
    expect(body).toContain('#### Added')
    expect(body).not.toMatch(/^### Added$/m)
  })

  it('keeps the install instructions for every target', () => {
    expect(body).toContain('translaneur-<version>-firefox.xpi')
    expect(body).toContain('translaneur-<version>-chrome.zip')
    expect(body).toContain('translaneur-<version>-thunderbird.xpi')
  })

  it('fails on a version without a CHANGELOG entry', () => {
    expect(() => buildReleaseBody(CHANGELOG, '9.9.9')).toThrow()
  })
})
