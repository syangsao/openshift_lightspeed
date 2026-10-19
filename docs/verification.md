# Verification

Smoke tests used to prove the deployment end-to-end (cluster + LLM + RAG + MCP). Run after the pods are `Running`/`Ready`.

## 0. Readiness

```bash
oc get pods -n openshift-lightspeed
oc port-forward svc/lightspeed-app-server 19443:8443 -n openshift-lightspeed &

curl -sk https://127.0.0.1:19443/readiness
# {"ready":true,"reason":"service is ready"}
```

## 1. Direct LLM check (no Lightspeed involved)

```bash
curl -s http://192.168.40.100:8022/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-27b","messages":[{"role":"user","content":"Say hi"}],"max_tokens":40}'
```

Expected: `content` present, `reasoning_content: null` (thinking disabled — see issue #1).

## 2. RAG / docs tool

```bash
TOKEN=$(oc whoami -t)
curl -sk -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST https://127.0.0.1:19443/v1/query \
  -d '{"query":"What is a SNO OpenShift cluster? Answer in one sentence."}'
```

Observed:

```json
{
  "conversation_id": "f996347d-...",
  "response": "A SNO (Single-Node OpenShift) cluster is an OpenShift deployment where all control-plane and worker components run on a single host, reducing infrastructure requirements for constrained or edge environments.",
  "referenced_documents": [ "...", "...", "...", "...", "..." ],
  "input_tokens": 1079, "output_tokens": 1
}
```

(5 references; ~9–10 s round trip.)

## 3. MCP cluster-interaction tool

```bash
curl -sk -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST https://127.0.0.1:19443/v1/query \
  -d '{"query":"How many nodes are in my cluster? Name them."}'
```

Observed: a markdown table of the 3 cluster nodes (arbiter/control01/control02 with roles and internal IPs) and `tool_calls: ["resources_list"]`.

## 4. Console

The `lightspeed-console-plugin` pod serves the UI; the Lightspeed assistant appears in the OpenShift web console once the plugin is `Running` (the operator registers it via a ConsolePlugin resource). Ask the same questions there to confirm the browser path.

## Regression checklist after any config change

- [ ] `POST /v1/query` with a **docs** question returns text and `referenced_documents`
- [ ] `POST /v1/query` with a **cluster** question returns a `tool_calls` entry and correct data
- [ ] `reasoning_content` is absent from direct llama.cpp responses (thinking off)
- [ ] `spec.ols.guardrails.toolResultInspection.enabled` matches the intended state (issue #2)
