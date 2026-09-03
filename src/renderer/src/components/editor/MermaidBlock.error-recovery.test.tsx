// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MermaidBlock from './MermaidBlock'

const renderDiagram = vi.hoisted(() =>
  vi.fn<(id: string, source: string) => Promise<{ svg: string }>>()
)

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: renderDiagram } }))
vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

beforeEach(() => {
  renderDiagram.mockReset()
  renderDiagram.mockImplementation(async (_id, source) => {
    if (source.startsWith('graph TDD')) {
      throw new Error('Parse error on line 1')
    }
    return { svg: `<svg data-source="${source.length}"></svg>` }
  })
})

describe('MermaidBlock error recovery', () => {
  it('shows the error banner with the source while the syntax is broken', async () => {
    const { container } = render(<MermaidBlock content="graph TDD" isDark={false} />)

    await waitFor(() => expect(container.querySelector('.mermaid-error')).not.toBeNull())
    expect(container.querySelector('.mermaid-error')?.textContent).toContain(
      'Parse error on line 1'
    )
    expect(container.querySelector('pre code')?.textContent).toBe('graph TDD')
    expect(container.querySelector('svg')).toBeNull()
  })

  it('hides the last good diagram behind the banner when the syntax breaks again', async () => {
    const { container, rerender } = render(
      <MermaidBlock content={'graph TD\n  A-->B'} isDark={false} />
    )
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull())

    rerender(<MermaidBlock content="graph TDD" isDark={false} />)

    await waitFor(() => expect(container.querySelector('.mermaid-error')).not.toBeNull())
    expect(container.querySelector('div[hidden] svg')).not.toBeNull()
    expect(container.querySelector('pre code')?.textContent).toBe('graph TDD')
  })

  it('clears the error and draws the diagram once the syntax is fixed', async () => {
    const { container, rerender } = render(<MermaidBlock content="graph TDD" isDark={false} />)
    await waitFor(() => expect(container.querySelector('.mermaid-error')).not.toBeNull())

    rerender(<MermaidBlock content={'graph TD\n  A-->B'} isDark={false} />)

    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull())
    expect(container.querySelector('.mermaid-error')).toBeNull()
    expect(container.querySelector('pre code')).toBeNull()
  })
})
