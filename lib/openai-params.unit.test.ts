import { describe, it, expect, vi } from 'vitest'
import {
  applyCustomParams,
  parseExtraBodyParams,
  parseNonNegativeInt,
} from './openai-params'

describe('parseExtraBodyParams', () => {
  it('treats blank input as no params', () => {
    expect(parseExtraBodyParams('')).toEqual({ ok: true, value: {} })
    expect(parseExtraBodyParams('   \n ')).toEqual({ ok: true, value: {} })
  })

  it('parses an object, including nested values', () => {
    expect(
      parseExtraBodyParams(
        '{"reasoning_effort":"low","thinking":{"type":"disabled"},"temperature":0}',
      ),
    ).toEqual({
      ok: true,
      value: {
        reasoning_effort: 'low',
        thinking: { type: 'disabled' },
        temperature: 0,
      },
    })
  })

  it('reports malformed JSON instead of throwing', () => {
    const result = parseExtraBodyParams('{bad json')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/^Invalid JSON: /)
  })

  it('rejects arrays and scalars, which are not body fragments', () => {
    for (const text of ['[1,2]', '"gpt-4o"', '42', 'null']) {
      const result = parseExtraBodyParams(text)
      expect(result).toEqual({ ok: false, error: 'Must be a JSON object' })
    }
  })

  it('rejects the keys the extension owns', () => {
    for (const key of ['model', 'messages', 'stream']) {
      const result = parseExtraBodyParams(`{"${key}": null}`)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error).toContain(
        `Cannot override "${key}"`,
      )
    }
  })

  it('rejects a reserved key even alongside valid ones', () => {
    const result = parseExtraBodyParams('{"temperature":0,"stream":true}')
    expect(result.ok).toBe(false)
  })
})

describe('parseNonNegativeInt', () => {
  it('reads whole numbers', () => {
    expect(parseNonNegativeInt('5')).toBe(5)
    expect(parseNonNegativeInt('0')).toBe(0)
  })

  it('falls back to 0 for input that is not a positive number', () => {
    for (const text of ['', '  ', '-3', 'abc', 'NaN', '1.5']) {
      expect(parseNonNegativeInt(text)).toBe(0)
    }
  })
})

describe('applyCustomParams', () => {
  it('writes user params onto the body', () => {
    const body: Record<string, any> = { model: 'gpt-4o-mini' }
    applyCustomParams(body, {
      reasoning_effort: 'low',
      thinking: { type: 'disabled' },
    })
    expect(body).toEqual({
      model: 'gpt-4o-mini',
      reasoning_effort: 'low',
      thinking: { type: 'disabled' },
    })
  })

  it('leaves extension-owned keys alone even when set directly in storage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const messages = [{ role: 'user', content: 'hi' }]
    const body: Record<string, any> = { model: 'gpt-4o-mini', messages }

    applyCustomParams(body, {
      model: 'attacker-model',
      messages: [],
      stream: true,
      temperature: 0,
    })

    expect(body.model).toBe('gpt-4o-mini')
    expect(body.messages).toBe(messages)
    expect(body).not.toHaveProperty('stream')
    expect(body.temperature).toBe(0)
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })
})