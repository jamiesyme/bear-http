import { Buffer } from "node:buffer"
import { IncomingMessage, ServerResponse } from "node:http"
import { PassThrough, Readable, Stream } from "node:stream"
import { finished, pipeline } from "node:stream/promises"
import { ReadableStream } from "node:stream/web"

/**
 * @typedef {object} BearRequest
 * @prop {string}          method
 * @prop {string}          url
 * @prop {object}          headers
 * @prop {Readable}        body
 * @prop {IncomingMessage} nodeRequest
 * @prop {ServerResponse}  nodeResponse
 */

/**
 * @typedef {object} BearResponse
 * @prop {number}                   [status]
 * @prop {object}                   [headers]
 * @prop {(Readable|Buffer|string)} [body]
 */

/**
 * @typedef {Function} BearRequestHandler
 * @param {BearRequest}
 * @returns {BearResponse}
 */

/**
 * @typedef {Function} NodeHttpRequestListener
 * @param {IncomingMessage}
 * @param {ServerResponse}
 */

const defaultOptions = {
	parseRequest,
	writeResponse,
	writeResponseBody,
	cleanUpResponse,
	onError: ({ error }) => console.error(error),
}

/**
 * @param {BearRequestHandler} handlerFn
 * @param {*} options
 * @returns {NodeHttpRequestListener}
 */
export function createRequestListener (handlerFn, options)
{
	const {
		parseRequest,
		writeResponse,
		writeResponseBody,
		cleanUpResponse,
		onError,
	} = {
		...defaultOptions,
		...options,
	}

	return async function requestListener (nodeRequest, nodeResponse)
	{
		let request
		let response

		try {
			request = await parseRequest(nodeRequest, nodeResponse)
			response = await handlerFn(request)
			await writeResponse(nodeResponse, response, {
				writeBody: writeResponseBody,
			})
		} catch (error) {
			await onError?.({
				error,
				nodeRequest,
				nodeResponse,
				request,
				response,
			})
			await cleanUpResponse(nodeResponse)
		}
	}
}

export function parseRequest (nodeRequest, nodeResponse)
{
	// We use a passthrough stream to make `body` a stream without inheriting
	// all of the `IncomingMessage` properties.
	//
	const body = new PassThrough()
	nodeRequest.pipe(body)

	return {
		method: nodeRequest.method,
		url: nodeRequest.url,
		headers: nodeRequest.headers,
		body,
		nodeRequest,
		nodeResponse,
	}
}

export async function writeResponse (nodeResponse, response, options)
{
	if (!nodeResponse.headersSent) {
		if (response?.status !== undefined) {
			nodeResponse.statusCode = response?.status
		} else {
			const isHead = nodeResponse.req.method === "HEAD"
			const hasBody =
				response?.body !== undefined && response?.body !== null
			if (isHead || !hasBody) {
				nodeResponse.statusCode = 204
			} else {
				nodeResponse.statusCode = 200
			}
		}

		const headers = response?.headers ?? {}
		for (let key in headers) {
			nodeResponse.setHeader(key, headers[key])
		}
	}

	if (!nodeResponse.writableEnded) {
		const _writeBody = options?.writeBody ?? writeResponseBody
		await _writeBody(nodeResponse, response?.body)

		if (!nodeResponse.writableEnded) {
			nodeResponse.end()
		}
	}

	await finished(nodeResponse, { cleanup: true })
}

export async function writeResponseBody (nodeResponse, body)
{
	if (body === undefined || body === null) {
		nodeResponse.end()
	} else if (typeof body === "string") {
		await writeStringResponseBody(nodeResponse, body)
	} else if (body instanceof Buffer) {
		await writeBufferResponseBody(nodeResponse, body)
	} else if (body instanceof ReadableStream) {
		await writeStreamResponseBody(nodeResponse, Readable.fromWeb(body))
	} else if (body instanceof Stream) {
		await writeStreamResponseBody(nodeResponse, body)
	} else {
		throw new Error("unknown response body type")
	}
}

export async function writeStringResponseBody (nodeResponse, string)
{
	if (!nodeResponse.headersSent && !nodeResponse.hasHeader("content-type")) {
		nodeResponse.setHeader("content-type", "text/plain")
	}

	await writeBufferResponseBody(nodeResponse, Buffer.from(string))
}

export async function writeBufferResponseBody (nodeResponse, buffer)
{
	if (!nodeResponse.headersSent) {
		if (!nodeResponse.hasHeader("content-length")) {
			nodeResponse.setHeader("content-length", buffer.length)
		}
		if (!nodeResponse.hasHeader("content-type")) {
			nodeResponse.setHeader("content-type", "application/octet-stream")
		}
	}

	if (nodeResponse.req.method === "HEAD") {
		nodeResponse.end()
	} else {
		nodeResponse.end(buffer)
	}
}

export async function writeStreamResponseBody (nodeResponse, stream)
{
	if (!nodeResponse.headersSent && !nodeResponse.hasHeader("content-type")) {
		nodeResponse.setHeader("content-type", "application/octet-stream")
	}

	if (nodeResponse.req.method === "HEAD") {
		nodeResponse.end()
	} else {
		await pipeline(stream, nodeResponse)
	}
}

export async function cleanUpResponse (nodeResponse)
{
	if (!nodeResponse.headersSent) {
		nodeResponse.statusCode = 500
		nodeResponse.getHeaderNames().map((h) => nodeResponse.removeHeader(h))
	}

	if (!nodeResponse.writableEnded) {
		nodeResponse.end()
	}

	// The `cleanup` flag below is unrelated to the cleanup that we're
	// performing in this function; the flag is to prevent Node from leaving
	// dangling event listeners on the response.
	//
	// The `error` flag tells Node to ignore errors on the stream. We don't
	// care if an error occurs at this point, we just want to know when the
	// stream is closed.
	//
	await finished(nodeResponse, {
		cleanup: true,
		error: false,
	})
}
