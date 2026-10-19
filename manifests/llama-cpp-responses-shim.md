# Responses-API compatibility shim (`ols-shim`)

Lightspeed's OpenAI client uses the **Responses API** (`/v1/responses`). llama.cpp's streaming implementation omits `output_index` on `response.output_item.added`, `response.output_item.done` and `response.function_call_arguments.delta`. The OpenAI SDK correlates streamed tool-call deltas by that field, so when the model emits **parallel tool calls** all argument deltas land in the first item and the others end up empty. The corrupt call is then replayed and llama.cpp rejects it with HTTP 500 (`Failed to parse tool call arguments as JSON`) — see [issue #7](../docs/issues.md#7-danger-alert-llm-backend-an-error-occurred-during-llm-invocation).

Upstream is unfixed (llama.cpp #20607 closed stale; current `master` still has no `output_index`). Until it lands, run a small SSE shim in front of llama.cpp.

## What it does

- **Response side:** injects `output_index` on output-item and argument-delta events (tracks item ids → indices per stream), plus `id` on function-call items and `created_at` / `model` on `response.created`.
- **Request side:** strips `reasoning` history items (llama.cpp rejects them) and normalizes bare assistant messages. Non-SSE responses pass through untouched.
- Listen port `8023` on the host, upstream `http://127.0.0.1:8022`.

Source: [MidnightOnMars/llama-cpp-responses-proxy](https://github.com/MidnightOnMars/llama-cpp-responses-proxy) (MIT). A copy is kept at [`shim/proxy.mjs`](shim/proxy.mjs) so the deployment does not depend on a third-party repo staying online.

## Deploy

```bash
mkdir -p ~/ols-shim
cp manifests/shim/proxy.mjs ~/ols-shim/proxy.mjs

docker run -d --name ols-shim --restart unless-stopped --network host \
  -e LLAMA_CPP_URL=http://127.0.0.1:8022 \
  -e PROXY_HOST=0.0.0.0 \
  -e PROXY_PORT=8023 \
  -v ~/ols-shim/proxy.mjs:/app/proxy.mjs:ro \
  node:22-alpine node /app/proxy.mjs
```

Check:

```bash
docker logs ols-shim          # "listening on 0.0.0.0:8023"
curl -s http://localhost:8023/v1/models | head -c 100
# stream patching: output_index should appear on events
curl -s -N http://localhost:8023/v1/responses -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-27b","stream":true,
       "input":[{"type":"message","role":"user","content":"hi"}],
       "tools":[{"type":"function","name":"f","parameters":{"type":"object","properties":{}}}]}' \
  | grep -o '"output_index":[0-9]*' | sort -u
```

## Point Lightspeed at it

`spec.llm.providers[0].url: http://<shim-host>:8023/v1` (see [`olsconfig.yaml`](olsconfig.yaml)). Rollout takes ~60 s.

## Verification performed

- Direct SSE through the shim: `output_index` present on `output_item.added` and every `function_call_arguments.delta`.
- End-to-end, three consecutive runs of *“What are the nodes and their conditions?”* (deterministically produced 3 parallel `resources_get` calls): all answered; packet capture showed the replayed history with **per-call correct arguments**, no concatenation and no empties.

## Remove

```bash
docker rm -f ols-shim
oc patch olsconfig cluster -p '{"spec":{"llm":{"providers":[{"url":"http://192.168.40.100:8022/v1"}]}}}' --type=merge
```

(Or restore the URL in `olsconfig.yaml` and re-apply.)
