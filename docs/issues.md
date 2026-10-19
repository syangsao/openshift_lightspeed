# Issue log

Every problem encountered bringing OpenShift Lightspeed 1.0 up against a local llama.cpp server, with root causes and status. Ordered by impact.

| # | Issue | Status |
|---|---|---|
| 1 | [Tool calls 400 — empty reasoning item](#1-tool-calling-queries-fail-with-http-400-itemcontent-is-empty) | Worked around (thinking off); upstream #29159 / PR #29412 open |
| 2 | [Tool-result inspection fails closed](#2-tool-result-safety-inspection-fails-closed--tool-result-failed-the-safety-inspection) | Disabled (documented trade-off) |
| 3 | [First boot: Solr race](#3-first-boot-app-server-crash-loops-while-solr-starts) | Self-resolving |
| 4 | [Operator leader-election churn](#4-operator-restarts-with-leader-election-lost-during-the-initial-image-pull) | Self-healing |
| 5 | [`oc whoami -t` with cert kubeconfig](#5-oc-whoami--t-fails-against-a-client-certificate-kubeconfig) | Documented workaround |
| 6 | [Doc gotchas](#6-notes-from-the-documentation-that-are-easy-to-miss) | Reference |
| 7 | [Intermittent 500 on empty tool-call args](#7-danger-alert-llm-backend-an-error-occurred-during-llm-invocation) | Intermittent; new chat recovers; upstream #25510 open |

---

## 1. Tool-calling queries fail with HTTP 400 `item['content'] is empty`

**Symptom**

Any question that causes a tool call (docs search, cluster interaction) returns:

```json
{"detail":{"response":"[LLM Backend] item['content'] is empty",
           "cause":"Error code: 400 - {'error': {'code': 400, 'message': \"item['content'] is empty\", 'type': 'invalid_request_error'}}"}}
```

Plain questions that do not invoke a tool answer normally (`{"response":"hello", ...}`).

**Evidence**

Packet capture of OLS → llama.cpp showed two `/v1/responses` calls:

1. first call: `200 OK` — items: `[system message, user message]`
2. second call (after the tool result): `400` — items:

```
[0] message  role=system   len=5020
[1] message  role=user     len=32
[2] reasoning              content=[]        <-- rejected
[3] function_call          call_id=...       (accepted on its own)
[4] function_call_output   call_id=...
```

Minimal reproduction against the server:

```bash
curl -s http://<llm-host>:8022/v1/responses -H 'Content-Type: application/json' -d '{
 "model":"qwen3.8-27b",
 "input":[{"type":"message","role":"user","content":"hi"},
          {"type":"reasoning","content":[]},
          {"type":"function_call","call_id":"c1","name":"f","arguments":"{}"},
          {"type":"function_call_output","call_id":"c1","output":"ok"}]}'
# -> 400 "Cannot determine type of 'item'"  (or "item['content'] is empty" for other shapes)
```

Removing the `reasoning` item returns `200 OK`, so the sole trigger is the **`reasoning` history item**.

**Root cause**

OLS replays the `reasoning` output item from the model's previous response in the next `/v1/responses` request's `input` (standard Responses-API conversation continuation). The llama.cpp build in use (build 11669 / `0.7.0-dev`, commit `620d2225c`) classifies input items by the shape of their optional fields, so a reasoning item with empty/`null` content falls through to the generic “unknown item type” errors.

Upstream:
- Issue: **ggml-org/llama.cpp#29159** — *“/v1/responses: reasoning item with "summary": null rejected as "Cannot determine type of 'item'"”* (open)
- Fix PR: **#29412** — *“server: accept reasoning items without content in /v1/responses”* (open, unmerged as of 2026-10)

**Workaround (in use)**

Disable thinking on the llama.cpp server so no `reasoning` items are produced or replayed. This is the club-3090 compose's standard switch:

```yaml
# compose environment
- ENABLE_THINKING=${ENABLE_THINKING:-false}
```

Boot log then shows:

```
[sampler] INSTRUCT row: reasoning=off temp=0.7 top_p=0.80 presence=1.5
```

and responses no longer contain `reasoning_content`. Verified: tool calls, RAG answers, and cluster MCP queries all succeed.

**Status:** Worked around. Revisit when #29412 merges (then `ENABLE_THINKING=true` can be restored).

---

## 2. Tool-result safety inspection fails closed → “tool result failed the safety inspection”

**Symptom**

```
{"detail":{"response":"Lightspeed stopped the operation because a tool result failed the safety inspection.","cause":""}}
```

**Evidence**

App-server log:

```
ols.src.tools.tool_result_inspection.ToolResultInspectionError: tool-result classifier failed
pydantic_core._pydantic_core.ValidationError: 1 validation error for ToolResultInspectionDecision
  Invalid JSON: expected value at line 1 column 1 [type=json_invalid,
  input_value='Based on the provided do...c remains routed to the', input_type=str]
```

The classifier asks the LLM for a JSON decision; the model answers with prose. The guardrail fails **closed** on any classifier error, so every tool-using query is blocked.

**Root cause**

Model instruction-following: Qwen3.8-27B does not reliably emit the strict JSON the classifier expects from its prompt. Reproduced **both with thinking on and off**, so it is unrelated to issue #1. It is not fixable from the server side (no per-call temperature/format control is exposed to the classifier).

**Workaround (in use)**

```yaml
spec:
  ols:
    guardrails:
      toolResultInspection:
        enabled: false
```

`enabled` is exposed in the 1.0 CRD (`spec.ols.guardrails.toolResultInspection`) and defaults to `true`.

**Status:** Disabled. **Security note:** this guardrail defends against prompt injection via tool output. The reference deployment's sources are local and trusted (Red Hat docs via OKP, local MCP server); re-enable if you consume untrusted tool sources and use a model that reliably produces strict JSON.

---

## 3. First boot: app-server crash-loops while Solr starts

**Symptom**

After applying the `OLSConfig`, `lightspeed-app-server` restarts repeatedly:

```
Solr not ready (attempt 11/36): [Errno 111] Connection refused
...
Liveness probe failed: ...:8443/liveness: dial tcp ...: connect: connection refused
Killing  Container lightspeed-service-api failed liveness probe, will be restarted
```

`lightspeed-rhokp` (Solr) is still at `0/1` with `startup probe failed: HTTP probe failed with statuscode: 503`, even though its log says `Started Solr server on port 8983`.

**Root cause**

Startup ordering: the app server blocks on Solr readiness before it opens its HTTPS listener, but the liveness probe starts firing earlier and kills the process. Solr's `portal-rag` core needs several minutes to load its index (startup probe allowance: ~20s initial + 34 × 10s ≈ 6 min).

**Resolution**

None needed — self-resolving. Wait for `lightspeed-rhokp` to become `1/1`; the app server then starts cleanly on the next restart. Observed ~5 minutes on `luke` (3 nodes: 1 arbiter + 2 control-plane/worker); slower nodes/bigger indexes extend it.

---

## 4. Operator restarts with “leader election lost” during the initial image pull

**Symptom**

```
leaderelection Failed to renew lease {"lock":"openshift-lightspeed/0ca034e3.openshift.io","err":"context deadline exceeded"}
ERROR setup problem running manager {"error":"leader election lost"}
```

**Root cause**

Transient scheduling/CPU pressure while the operator and all Lightspeed images pull at once (the lease renewal deadline is short). Not configuration-related.

**Resolution**

Self-heals; the operator re-acquires the lease and continues reconciling. No action taken.

---

## 5. `oc whoami -t` fails against a client-certificate kubeconfig

**Symptom**

```bash
$ TOKEN=$(oc whoami -t)
error: no token is currently in use for this session
```

**Root cause**

The kubeconfig in use authenticates with a **client certificate** (`users[].user.client-certificate-data`), not an OAuth token. The Lightspeed API validates bearer tokens against the cluster OAuth server, so testing it requires a token, not a certificate.

**Workaround**

```bash
oc login https://api.<cluster>:6443 -u kubeadmin -p "$(cat .../kubeadmin-password)" \
  --insecure-skip-tls-verify=true --kubeconfig=/tmp/kc-user.yaml
TOKEN=$(oc whoami -t --kubeconfig=/tmp/kc-user.yaml)
```

Any non-kubeadmin user with console access works as well (the console supplies its own token).

---

## 6. Notes from the documentation that are easy to miss

- The published 1.0 configuration guide only shows cloud providers; **`openai` type is the generic OpenAI-compatible client** and works with llama.cpp. The provider URL must end with `/v1`.
- The service API endpoint in 1.0 is **`/v1/query`**, not `/v1/chat` (2.x-era examples are stale).
- Cluster interaction (MCP) is **on by default** in 1.0 — the `introspectionEnabled` patch from the 2025 developer article applies to 2.x technology preview.
- OKP/Solr requests **~75 GiB ephemeral storage** by default (`spec.ols.deployment.rhokp` to tune).
- `spec.llm.providers[].credentialKey` selects the secret key (defaults to `apitoken`).

---

## 7. “Danger alert: [LLM Backend] An error occurred during LLM invocation”

**Symptom**

The web console shows:

```
Danger alert:[LLM Backend] An error occurred during LLM invocation. Please contact your OpenShift Lightspeed administrator.
```

Intermittent; usually right after a tool ran successfully (observed after `pods_list`).

**Evidence**

App-server log:

```
HTTP Request: POST http://192.168.40.100:8022/v1/responses "HTTP/1.1 500 Internal Server Error"
ERROR: LLM invocation failed: provider=local_llamacpp, model=qwen3.8-27b, elapsed=1.27s
ERROR: Error code: 500 - {'error': {'code': 500, 'message': 'Failed to parse tool call arguments as JSON:
  [json.exception.parse_error.101] parse error at line 1, column 1: attempting to parse an empty input;
  check that your input string or stream contains the expected JSON', 'type': 'server_error'}}
ERROR: Parsed LLM error (streaming): status_code=500, response_text=[LLM Backend] An error occurred during LLM invocation...
```

llama.cpp log shows three identical `srv operator(): got exception: {... "Failed to parse tool call arguments as JSON" ...}` (OLS retries).

**Root cause (confirmed by packet capture)**

llama.cpp's `/v1/responses` streaming emits **no `output_index` field** on `response.output_item.added`, `response.output_item.done`, or `response.function_call_arguments.delta`. The OpenAI Python SDK (used by OLS via `langchain-openai`) correlates streamed tool-call deltas by output index, so when the model emits **parallel tool calls in one response**, all argument deltas are appended to the first item and the other items end up with empty arguments.

Capture of a failing turn (query: *“What are the nodes and their conditions?”*; model emitted 3 parallel `resources_get` calls — one per node):

```
stream (correct):  output_item.added id=fc_Q4…  call_id=call_Q4…  args=''
                   …deltas id=fc_Q4…  ('{', '"apiVersion":"', '"v1"', … )
                   output_item.added id=fc_tT…  call_id=call_tT…  args=''
                   output_item.added id=fc_oP…  call_id=call_oP…  args=''
                   output_item.done  → 3 items, each with its correct args

next request (corrupt replay):
  resources_get args='{"apiVersion":"v1","kind":"Node","name":"arbiter.syangsao.net"}
                     {"apiVersion":"v1","kind":"Node","name":"control01.syangsao.net"}
                     {"apiVersion":"v1","kind":"Node","name":"control02.syangsao.net"}'
  resources_get args=''
  resources_get args=''
```

llama.cpp then strictly `json::parse()`es the replayed `arguments`, fails (`unexpected '{'; expected end of input` / `attempting to parse an empty input`) and returns HTTP 500 — surfaced by OLS as the generic watchdog alert. The corrupt call stays in the conversation history, so the chat fails on every subsequent turn until a new conversation is started.

Upstream references:
- **ggml-org/llama.cpp#20607** — *“/v1/responses streaming SSE missing fields required by Vercel AI SDK (output_index, id on function_call items, created_at/model)”* — closed **stale**, not fixed. Current `master` still contains no `output_index` (verified 2026-10).
- **ggml-org/llama.cpp#25510** — malformed replayed tool-call arguments return 500 instead of 4xx (open; describes the wedged-conversation behavior).
- **ggml-org/llama.cpp#18591** — streaming tool calling with multiple calls broken.
- `MidnightOnMars/llama-cpp-responses-proxy` — MIT compatibility shim that injects the missing fields (and normalizes replayed history). The only working fix available while upstream is unfixed.

**Mitigations**

1. **Deployed: Responses-API shim** (`ols-shim`, `:8023` → llama.cpp `:8022`) injects `output_index` so the SDK keeps parallel calls separate. `spec.llm.providers[].url` points at the shim. See [../manifests/llama-cpp-responses-shim.md](../manifests/llama-cpp-responses-shim.md). Verified end-to-end: three consecutive runs of the deterministic failing query all answered, and the capture showed per-call correct arguments in the replayed history.
2. **Start a new conversation** for chats wedged *before* the shim was in place — their history still contains the corrupt call.
3. Lower `TEMP` is **not** a fix (the merge happens with any parallel tool call).
4. Permanent fix must land in llama.cpp (#20607 / #25510); current `master` still lacks `output_index`.

**Status:** **Fixed by the shim** for new conversations (2026-10-19). Upstream remains broken; the shim is required until llama.cpp implements the fields.

---

## Observation: model quality

Qwen3.8-27B handles tool selection well (docs search + `resources_list`), but one test run answered “5 nodes” and invented two worker names before settling on the correct 3-node answer on a retry. For production cluster interaction, verify tool outputs or increase sampling determinism; the model is good, not flawless.
