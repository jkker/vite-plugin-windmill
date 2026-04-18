export const devRuntimeSource = String.raw`
const requestJson = async (path, body) => {
	const response = await fetch(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	})

	const payload = await response.json()
	if (!response.ok || payload.error) {
		throw new Error(
			payload.error ?? 'Windmill dev request failed with status ' + response.status,
		)
	}

	return payload.result
}

export const backend = new Proxy(
	{},
	{
		get(_, runnableId) {
			return async (v) =>
				requestJson('/__windmill__/backend', { runnableId, args: v ?? {} })
		},
	},
)

export const backendAsync = new Proxy(
	{},
	{
		get(_, runnableId) {
			return async (v) =>
				requestJson('/__windmill__/backend-async', { runnableId, args: v ?? {} })
		},
	},
)

export const waitJob = async (jobId) => requestJson('/__windmill__/wait-job', { jobId })

export const getJob = async (jobId) => requestJson('/__windmill__/get-job', { jobId })

export const streamJob = async (jobId, onUpdate) =>
	new Promise((resolve, reject) => {
		const source = new EventSource(
			'/__windmill__/stream-job/' + encodeURIComponent(jobId),
		)

		source.addEventListener('update', (event) => {
			const data = JSON.parse(event.data)
			onUpdate?.(data)
		})

		source.addEventListener('done', (event) => {
			source.close()
			resolve(JSON.parse(event.data))
		})

		source.addEventListener('error', (event) => {
			source.close()
			const message =
				event instanceof MessageEvent && typeof event.data === 'string'
					? event.data
					: 'Windmill stream request failed'
			reject(new Error(message))
		})
	})
`;
