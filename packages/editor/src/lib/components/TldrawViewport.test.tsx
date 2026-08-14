import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { vi } from 'vitest'
import { createTLStore } from '../config/createTLStore'
import { StateNode } from '../editor/tools/StateNode'
import { TldrawEditor } from '../TldrawEditor'
import { TldrawViewport } from './TldrawViewport'

class HandTool extends StateNode {
	static override id = 'hand'
}

class DrawTool extends StateNode {
	static override id = 'draw'
}

describe('TldrawViewport direct pointer panning', () => {
	async function renderViewport(tool: typeof HandTool | typeof DrawTool, onCameraChange = vi.fn()) {
		const store = createTLStore({ shapeUtils: [], bindingUtils: [] })

		function Canvas() {
			const [camera, setCamera] = useState({ x: 10, y: 20, z: 2 })
			return (
				<TldrawViewport
					id="test-viewport"
					camera={camera}
					onCameraChange={(nextCamera) => {
						onCameraChange(nextCamera)
						setCamera(nextCamera)
					}}
				/>
			)
		}

		await act(async () => {
			render(
				<TldrawEditor store={store} tools={[tool]} initialState={tool.id} components={{ Canvas }} />
			)
		})
		return onCameraChange
	}

	it.each(['touch', 'pen'])(
		'pans with a primary %s pointer under the hand tool',
		async (pointerType) => {
			const onCameraChange = await renderViewport(HandTool)
			const viewport = screen.getByTestId('tldraw-viewport')

			act(() => {
				fireEvent.pointerDown(viewport, {
					pointerId: 1,
					pointerType,
					isPrimary: true,
					clientX: 100,
					clientY: 200,
				})
				fireEvent.pointerMove(viewport, {
					pointerId: 1,
					pointerType,
					isPrimary: true,
					clientX: 120,
					clientY: 210,
				})
			})

			expect(onCameraChange).toHaveBeenLastCalledWith({ x: 20, y: 25, z: 2 })
		}
	)

	it('leaves pen input with a drawing tool', async () => {
		const onCameraChange = await renderViewport(DrawTool)
		const viewport = screen.getByTestId('tldraw-viewport')

		act(() => {
			fireEvent.pointerDown(viewport, {
				pointerId: 1,
				pointerType: 'pen',
				isPrimary: true,
				clientX: 100,
				clientY: 200,
			})
			fireEvent.pointerMove(viewport, {
				pointerId: 1,
				pointerType: 'pen',
				isPrimary: true,
				clientX: 120,
				clientY: 210,
			})
		})

		expect(onCameraChange).not.toHaveBeenCalled()
	})
})
