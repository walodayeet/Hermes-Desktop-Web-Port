// @vitest-environment jsdom
/**
 * Web port regression tests — "Copy ID" must never be a silent no-op.
 *
 * Contract under test:
 *  (a) a real copy payload reaches the bridge (writeClipboard called with the
 *      exact text) and reports success;
 *  (b) an empty/undefined payload fires the ERROR path (onCopyError) instead
 *      of the old silent `if (!value) return` — a Copy ID item whose id
 *      failed to resolve is the bug reported as "copies nothing, no toast".
 *
 * The radix-ui primitives (Button/ContextMenuItem/DropdownMenuItem/Tip) are
 * mocked to plain elements: this repo does not hoist react-dom to the root
 * node_modules, so radix's react-dom import cannot resolve under vitest's
 * node-side transform. The component under test is CopyButton itself.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CopyButton } from './copy-button'

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...rest }: { children?: ReactNode }) => <button {...rest}>{children}</button>
}))
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenuItem: ({ children, ...rest }: { children?: ReactNode }) => <button {...rest}>{children}</button>
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children, ...rest }: { children?: ReactNode }) => <button {...rest}>{children}</button>
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children?: ReactNode }) => <>{children}</>
}))
// @tabler/icons-react ships pre-built elements that trip React's
// "element from an older version of React" guard under vitest's transform —
// not the component under test.
vi.mock('@/lib/icons', () => ({
  Check: () => <span data-icon="check" />,
  Copy: () => <span data-icon="copy" />,
  X: () => <span data-icon="x" />
}))
// The real i18n catalog imports every tabler icon (and reaches into the api
// graph); the component only reads four common strings.
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: {
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        failed: 'Failed'
      }
    }
  })
}))

let container: HTMLElement
let root: Root

function mount(element: ReactElement): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(element)
  })

  return container
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  delete window.hermesDesktop
})

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.hermesDesktop = {
    writeClipboard: vi.fn(async () => true)
  } as unknown as typeof window.hermesDesktop
})

describe('CopyButton payload handling', () => {
  it('(a) copies a real value through the bridge and reports success', async () => {
    const writeClipboard = vi.mocked(window.hermesDesktop!.writeClipboard!)
    const onCopied = vi.fn()
    const onCopyError = vi.fn()

    mount(<CopyButton onCopied={onCopied} onCopyError={onCopyError} text="session-abc-123" />)

    act(() => {
      clickButton()
    })
    await act(async () => {})

    expect(writeClipboard).toHaveBeenCalledWith('session-abc-123')
    expect(onCopied).toHaveBeenCalled()
    expect(onCopyError).not.toHaveBeenCalled()
  })

  it('(b) surfaces an error for an empty payload instead of silently returning', async () => {
    const writeClipboard = vi.mocked(window.hermesDesktop!.writeClipboard!)
    const onCopyError = vi.fn()

    mount(<CopyButton onCopyError={onCopyError} text="" />)

    act(() => {
      clickButton()
    })
    await act(async () => {})

    expect(onCopyError).toHaveBeenCalled()
    expect(writeClipboard).not.toHaveBeenCalled()
  })
})

function clickButton(): void {
  const buttons = [...container.querySelectorAll('button')]

  if (buttons.length !== 1) {
    throw new Error(`expected exactly one button, got ${buttons.length}`)
  }

  buttons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}