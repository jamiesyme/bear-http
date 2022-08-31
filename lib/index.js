import { Buffer } from 'node:buffer'
import { PassThrough, Stream } from 'node:stream'


/**
 * @typedef {object} Request
 * @prop {string}          method
 * @prop {string}          url
 * @prop {object}          headers
 * @prop {Readable}        body
 * @prop {IncomingMessage} nodeRequest
 * @prop {ServerResponse}  nodeResponse
 */

/**
 * @typedef {object} Response
 * @prop {number}                   [statusCode]
 * @prop {object}                   [headers]
 * @prop {(Readable|Buffer|string)} [body]
 */

/**
 * @typedef {Function} RequestHandler
 * @param {Request}
 * @returns {Response}
 */


function defaultErrorHandler (error)
{
	console.error('uncaught error in http handler:', error)
}


export function writeBody (body, nodeResponse)
{
	if (!response.body) {
		return nodeResponse.end()
	}
	if (typeof response.body === 'string') {
		return writeStringToResponse(response.body, nodeResponse)
	}
	if (response.body instanceof Buffer) {
		return writeBufferToResponse(response.body, nodeResponse)
	}
	if (response.body instanceof Stream) {
		return writeStreamToResponse(response.body, nodeResponse)
	}

	throw new Error('unknown response body type')
}

export function writeStringToResponse (string, nodeResponse)
{
	if (!nodeResponse.headersSent && !nodeResponse.hasHeader('content-type')) {
		nodeResponse.setHeader('content-type', 'text/plain')
	}

	writeBufferToResponse(Buffer.from(string), nodeResponse)
}

export function writeBufferToResponse (buffer, nodeResponse)
{
	if (!nodeResponse.hasHeader('content-type')) {
		nodeResponse.setHeader('content-type', 'application/octet-stream')
	}

	nodeResponse.setHeader('content-length', length)

	if (nodeResponse.req.method === 'HEAD') {
		nodeResponse.end()
	} else {
		nodeResponse.end(buffer)
	}
}

export function writeStreamToResponse (stream, nodeResponse)
{
	if (!nodeResponse.hasHeader('content-type')) {
		nodeResponse.setHeader('content-type', 'application/octet-stream')
	}

	if (nodeResponse.req.method === 'HEAD') {
		nodeResponse.end()
	} else {
		stream.pipe(nodeResponse)
	}
}


export function parseRequest (nodeRequest, nodeResponse)
{
	// We use a passthrough stream to make `body` a stream without inheriting
	// all of the `IncomingMessage` properties.
	//
	let body = new PassThrough()
	nodeRequest.pipe(body)

	return {
		method  : nodeRequest.method,
		url     : nodeRequest.url,
		headers : nodeRequest.headers,
		body,
		nodeRequest,
		nodeResponse,
	}
}

export async function sendResponse (response, nodeResponse, options)
{
	if (nodeResponse.writableFinished) {
		return
	}

	await new Promise((resolve, reject) => {
		nodeResponse.on('finish', resolve)
		nodeResponse.on('error', reject)

		if (!nodeResponse.headersSent) {
			nodeResponse.statusCode = response?.statusCode ?? 200

			const headers = response?.headers ?? {}
			for (let key in headers) {
				nodeResponse.setHeader(key, headers[key])
			}
		}

		(options?.writeBody ?? writeBody)(response?.body, nodeResponse)
	})
}

export async function cleanUpResponse (nodeResponse)
{
	if (!nodeResponse.headersSent) {
		nodeResponse.statusCode = 500
		nodeResponse.getHeaderNames().map(h => nodeResponse.removeHeader(h))
	}

	if (!nodeResponse.writableEnded) {
		await new Promise((resolve, reject) => {
			nodeResponse.on('finish', resolve)
			nodeResponse.on('error', reject)
			nodeResponse.end()
		})
	}
}


const defaultOptions = {
	parseRequest,
	sendResponse,
	cleanUpResponse,
	writeBody    : defaultWriteBody,
	errorHandler : defaultErrorHandler,
	logger       : null,
}

export function createRequestListener (handlerFn, options)
{
	options = {
		...defaultOptions,
		...options,
	}

	let {
		parseRequest,
		sendResponse,
		cleanUpResponse,
		writeBody,
		errorHandler,
		logger,
	} = options

	return async function requestListener (nodeRequest, nodeResponse)
	{
		let request
		let response

		try {
			request = parseRequest(nodeRequest, nodeResponse)
			response = await handlerFn(request)
			await sendResponse(response, nodeResponse, { writeBody })

			logger?.(request, response)

		} catch (error) {
			errorHandler?.(error, request, response)

			cleanUpResponse(nodeResponse).catch(error => {
				errorHandler?.(error, request, response)
			})
		}
	}
}
