// llama-cpp-responses-proxy
// Patches llama.cpp's /v1/responses streaming SSE to add fields required by
// strict OpenAI Responses clients such as @ai-sdk/openai. Without these
// fields, function_call chunks are treated as unknown and finishReason stays
// "stop" instead of "tool-calls".
//
// Missing fields patched:
//   1. output_index on output_item.added/.done and function_call_arguments.delta
//   2. id on function_call items (SDK requires both id and call_id)
//   3. created_at and model on response.created
// Request bodies patched:
//   4. strips prior reasoning items from /v1/responses continuation input
//      because llama.cpp rejects OpenCode follow-up requests that include them
//
// See: https://github.com/ggml-org/llama.cpp/issues/20607

import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const TARGET = process.env.LLAMA_CPP_URL || 'http://127.0.0.1:8080';
const PORT = parseInt(process.env.PROXY_PORT || '9998', 10);
const HOST = process.env.PROXY_HOST || '127.0.0.1';

export function createPatchState(requestModel = 'unknown') {
  return {
    outputIdx: 0,
    itemIndexMap: new Map(),
    model: requestModel,
  };
}

function isResponsesPath(pathname = '') {
  return pathname === '/v1/responses' || pathname.endsWith('/v1/responses');
}

function isReasoningInputItem(item) {
  return !!item && typeof item === 'object' && !Array.isArray(item) && item.type === 'reasoning';
}

function normalizeAssistantContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'output_text', text: content }];
  }
  if (!Array.isArray(content)) {
    return content;
  }

  return content.map((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      return part;
    }
    if (part.type === 'input_text') {
      return {
        ...part,
        type: 'output_text',
      };
    }
    return part;
  });
}

function normalizeResponsesInputItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return item;
  }
  if (item.role !== 'assistant' || item.type) {
    return item;
  }

  return {
    ...item,
    type: 'message',
    content: normalizeAssistantContent(item.content),
  };
}

export function patchRequestBody(body, pathname = '') {
  if (!isResponsesPath(pathname)) {
    return body;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  if (!Array.isArray(body.input)) {
    return body;
  }

  let changed = false;
  const normalizedInput = [];
  for (const item of body.input) {
    if (isReasoningInputItem(item)) {
      changed = true;
      continue;
    }

    const normalizedItem = normalizeResponsesInputItem(item);
    if (normalizedItem !== item) {
      changed = true;
    }
    normalizedInput.push(normalizedItem);
  }

  if (!changed) {
    return body;
  }

  return {
    ...body,
    input: normalizedInput,
  };
}

function getFunctionCallId(item, fallback) {
  return item.id || item.call_id || fallback;
}

function getItemKey(item) {
  return item.id || item.call_id || '';
}

export function patchEventData(data, state) {
  if (!data.type && data.error && typeof data.error === 'object') {
    data.type = 'error';
  }

  const type = data.type || '';

  if (type === 'response.created') {
    const response = data.response || {};
    if (!response.created_at) {
      response.created_at = Math.floor(Date.now() / 1000);
    }
    if (!response.model) {
      response.model = state.model;
    }
    data.response = response;
    state.model = response.model || state.model;
    return data;
  }

  if (type === 'response.output_item.added') {
    const item = data.item || {};
    if (item.type === 'function_call' && !item.id) {
      item.id = getFunctionCallId(item, `fc_${state.outputIdx}`);
    }
    if (data.output_index === undefined) {
      data.output_index = state.outputIdx;
    }
    const key = getItemKey(item);
    if (key) {
      state.itemIndexMap.set(key, data.output_index);
    }
    state.outputIdx = Math.max(state.outputIdx, data.output_index + 1);
    data.item = item;
    return data;
  }

  if (type === 'response.output_item.done') {
    const item = data.item || {};
    if (item.type === 'function_call' && !item.id) {
      item.id = getFunctionCallId(item, `fc_done_${data.output_index ?? 0}`);
    }
    const key = getItemKey(item);
    if (data.output_index === undefined) {
      data.output_index = state.itemIndexMap.get(key) ?? 0;
    }
    if (key && !state.itemIndexMap.has(key)) {
      state.itemIndexMap.set(key, data.output_index);
    }
    data.item = item;
    return data;
  }

  if (type === 'response.function_call_arguments.delta') {
    if (data.output_index === undefined) {
      data.output_index = state.itemIndexMap.get(data.item_id) ?? 0;
    }
    return data;
  }

  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = data.response || {};
    if (Array.isArray(response.output)) {
      for (const item of response.output) {
        if (item.type === 'function_call' && !item.id) {
          item.id = getFunctionCallId(item, 'fc_final');
        }
      }
    }
    if (!response.usage) {
      response.usage = { input_tokens: 0, output_tokens: 0 };
    }
    data.response = response;
    return data;
  }

  if (type === 'error') {
    if (data.sequence_number === undefined) {
      data.sequence_number = 0;
    }
    const error = data.error || {};
    if (typeof error.code === 'number') {
      error.code = String(error.code);
    }
    data.error = error;
    return data;
  }

  return data;
}

export function patchSseBlock(block, state) {
  const outLines = [];

  for (const line of block.split(/\r?\n/)) {
    let out = line;
    if (line.startsWith('data: ')) {
      try {
        const parsed = JSON.parse(line.slice(6));
        out = 'data: ' + JSON.stringify(patchEventData(parsed, state));
      } catch {
        // Pass through non-JSON data lines such as [DONE].
      }
    }
    outLines.push(out);
  }

  return outLines.join('\n');
}

function nextBlockBoundary(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');

  if (lf === -1 && crlf === -1) {
    return null;
  }
  if (lf === -1) {
    return { index: crlf, separatorLength: 4 };
  }
  if (crlf === -1 || lf < crlf) {
    return { index: lf, separatorLength: 2 };
  }
  return { index: crlf, separatorLength: 4 };
}

function getTransport(url) {
  return url.protocol === 'https:' ? https : http;
}

export function createProxyServer({
  target = TARGET,
  port = PORT,
  host = HOST,
} = {}) {
  const targetUrl = new URL(target);

  const server = http.createServer((clientReq, clientRes) => {
    const url = new URL(clientReq.url, targetUrl);
    const bodyChunks = [];

    clientReq.on('data', (chunk) => bodyChunks.push(chunk));
    clientReq.on('end', () => {
      const body = Buffer.concat(bodyChunks);
      let proxyBody = body;
      let requestModel = 'unknown';

      try {
        const parsedBody = JSON.parse(body.toString());
        const patchedBody = patchRequestBody(parsedBody, url.pathname);
        requestModel = patchedBody.model || requestModel;
        proxyBody = Buffer.from(JSON.stringify(patchedBody));
      } catch {
        // Non-JSON requests are forwarded unchanged.
      }

      const proxyReq = getTransport(url).request(url, {
        method: clientReq.method,
        headers: {
          ...clientReq.headers,
          host: url.host,
          'content-length': proxyBody.length,
        },
        timeout: 180000,
      }, (proxyRes) => {
        const contentType = proxyRes.headers['content-type'] || '';

        if (!contentType.includes('text/event-stream')) {
          clientRes.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
          proxyRes.pipe(clientRes);
          return;
        }

        clientRes.writeHead(proxyRes.statusCode ?? 200, {
          'Content-Type': contentType,
          'Cache-Control': proxyRes.headers['cache-control'] || 'no-cache',
          'Connection': proxyRes.headers.connection || 'keep-alive',
        });

        const state = createPatchState(requestModel);
        let buffer = '';

        proxyRes.setEncoding('utf-8');
        proxyRes.on('data', (chunk) => {
          buffer += chunk;

          for (;;) {
            const boundary = nextBlockBoundary(buffer);
            if (!boundary) {
              break;
            }

            const block = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary.separatorLength);
            clientRes.write(patchSseBlock(block, state) + '\n\n');
          }
        });

        proxyRes.on('end', () => {
          if (buffer.trim()) {
            clientRes.write(patchSseBlock(buffer, state));
          }
          clientRes.end();
        });

        proxyRes.on('error', (error) => {
          console.error('Proxy response error:', error.message);
          clientRes.end();
        });
      });

      clientReq.on('aborted', () => proxyReq.destroy());
      clientRes.on('close', () => proxyReq.destroy());

      proxyReq.on('error', (error) => {
        console.error('Proxy request error:', error.message);
        clientRes.writeHead(502);
        clientRes.end(JSON.stringify({ error: error.message }));
      });

      proxyReq.end(proxyBody);
    });
  });

  server.listen(port, host, () => {
    console.log(`llama-cpp-responses-proxy listening on ${host}:${port}`);
    console.log(`Forwarding to ${target}`);
  });

  return server;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  createProxyServer();
}
