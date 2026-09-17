// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getActiveMarkdownExportPayload } from './markdown-export-extract'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))

describe('getActiveMarkdownExportPayload', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
      })
    )
    const { useAppStore } = await import('@/store')
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [
        {
          id: '/repo/docs/readme.md',
          filePath: '/repo/docs/readme.md',
          relativePath: 'docs/readme.md',
          mode: 'edit'
        }
      ]
    } as never)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('embeds blob image sources so the PDF export window can render local images', async () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<div class="ProseMirror"><p><img src="blob:rich-local-image" alt="diagram"></p></div>'

    const payload = await getActiveMarkdownExportPayload({
      fileId: '/repo/docs/readme.md',
      root
    })

    expect(fetch).toHaveBeenCalledWith('blob:rich-local-image')
    expect(payload?.html).toContain('src="data:image/png;base64,AQID"')
    expect(payload?.html).not.toContain('blob:rich-local-image')
  })

  it('fails extraction when a blob image cannot be inlined', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false
    } as Response)
    const root = document.createElement('div')
    root.innerHTML =
      '<div class="ProseMirror"><p><img src="blob:missing-local-image" alt="diagram"></p></div>'

    await expect(
      getActiveMarkdownExportPayload({
        fileId: '/repo/docs/readme.md',
        root
      })
    ).rejects.toThrow('Failed to inline image for PDF export')
  })

  // #21198: preview renders the "Add note" control inside .markdown-body, so without scrubbing it
  // the PDF carries a + button above every block.
  it('drops the preview per-block annotation control', async () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<div class="markdown-body">' +
      '<div class="markdown-annotation-controls">' +
      '<button class="markdown-annotation-add" aria-label="Add note">+</button>' +
      '</div>' +
      '<h1>Overview</h1>' +
      '</div>'

    const payload = await getActiveMarkdownExportPayload({
      fileId: '/repo/docs/readme.md',
      root
    })

    expect(payload?.html).not.toContain('markdown-annotation')
    expect(payload?.html).not.toContain('Add note')
    expect(payload?.html).toContain('<h1>Overview</h1>')
  })

  // Why: the scrub must not reach past the affordance into the document itself.
  it('keeps document content that sits beside the annotation control', async () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<div class="markdown-body">' +
      '<p>Kept paragraph</p>' +
      '<div class="markdown-annotation-controls"><button>+</button></div>' +
      '<pre><code class="language-mermaid">graph TD;</code></pre>' +
      '</div>'

    const payload = await getActiveMarkdownExportPayload({
      fileId: '/repo/docs/readme.md',
      root
    })

    expect(payload?.html).toContain('Kept paragraph')
    expect(payload?.html).toContain('graph TD;')
    expect(payload?.html).not.toContain('markdown-annotation-controls')
  })
})
