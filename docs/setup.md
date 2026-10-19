# Setup

End-to-end deployment as executed against the `luke` cluster (OCP 4.22; 3 nodes — 1 arbiter + 2 control-plane/worker; not SNO). Substitute your own endpoints/names.

## Prerequisites

1. **OpenShift cluster** with an OLM-installed OpenShift Lightspeed operator:

   ```bash
   oc get csv -A | grep -i lightspeed
   # openshift-lightspeed   Succeeded
   ```

2. **LLM endpoint** with an OpenAI-compatible API, reachable **from the cluster nodes** (pods in the default OVN network reach it via the host IP; `localhost` inside a pod is not the host):

   ```bash
   # from a node (debug shell), confirm the endpoint answers before configuring anything
   oc debug nodes/control01 -- chroot /host \
     curl -s http://192.168.40.100:8022/v1/models
   ```

3. For the reference setup: llama.cpp serving `qwen3.8-27b` on port `8022`, booted with **thinking disabled** (see [../manifests/llama-cpp-compose-change.md](../manifests/llama-cpp-compose-change.md) — required for tool calls, see issue #1).

## Deploy

```bash
# 1. Credential secret — the key MUST be `apitoken`; value can be any
#    non-empty string for endpoints that do not authenticate.
oc create -f manifests/secret.yaml

# 2. OLSConfig — provider, model, guardrails
oc create -f manifests/olsconfig.yaml

# 3. Watch the rollout
oc get pods -n openshift-lightspeed -w
```

Expected pods once settled:

```
lightspeed-app-server-...        2/2   Running   # lightspeed-service-api + to-dataverse exporter
lightspeed-console-plugin-...    1/1   Running
lightspeed-operator-controller-manager-...  1/1   Running
lightspeed-otel-collector-...    1/1   Running
lightspeed-postgres-server-...   1/1   Running
lightspeed-rhokp-...             1/1   Running   # Solr / offline knowledge portal (OKP)
openshift-mcp-server-...         1/1   Running   # cluster interaction tools
```

**First boot is slow.** The app server waits for Solr on startup and restarts until `lightspeed-rhokp` is ready (~5–15 min depending on node speed). It resolves itself; see issue #3.

## Configuration notes

| Field | Value used | Notes |
|---|---|---|
| `llm.providers[].type` | `openai` | Right fit for llama.cpp (OpenAI-compatible). Allowed values in the 1.0 CRD: `azure_openai`, `bam`, `openai`, `watsonx`, `rhoai_vllm`, `rhelai_vllm` |
| `llm.providers[].url` | `http://192.168.40.100:8022/v1` | Must include the `/v1` suffix (pattern `^https?://.*$`; docs require ending in `v1`) |
| `models[].name` | `qwen3.8-27b` | Must match what the server reports in `/v1/models` |
| `models[].contextWindowSize` | `262144` | Server is launched with `-c 262144`; CRD default is 128k |
| `ols.defaultProvider` / `defaultModel` | matching names | CRD requires both to match a configured provider/model |
| `ols.guardrails.toolResultInspection.enabled` | `false` | See issue #2 |
| `ols.logLevel` | `INFO` | Useful while bringing the stack up |

Cluster interaction (MCP) ships **enabled by default** in 1.0 — no `introspectionEnabled` patch is needed (that was the 2.x-era technology preview). The operator deploys `openshift-mcp-server` and wires it into the app-server config automatically.

The operator renders its runtime config into the `olsconfig` ConfigMap; check it after applying the CR:

```bash
oc get cm olsconfig -n openshift-lightspeed -o yaml
```

## Testing the API from the CLI

The service API is **`POST /v1/query`** (not `/v1/chat`). Full schema: `curl -k https://<svc>/openapi.json` (OpenAPI 1.1.5).

```bash
# port-forward the service
oc port-forward svc/lightspeed-app-server 19443:8443 -n openshift-lightspeed &

# needs a real OAuth token (see issue #5 if `oc whoami -t` fails)
TOKEN=$(oc whoami -t)

curl -sk -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST https://127.0.0.1:19443/v1/query \
  -d '{"query":"What is a SNO OpenShift cluster? Answer in one sentence."}'
```

Response fields: `response`, `referenced_documents`, `tool_calls`, `tool_results`, `input_tokens`, `output_tokens`, `conversation_id`.

Available paths: `/v1/query`, `/v1/streaming_query`, `/v1/mcp/client-auth-headers`, `/v1/mcp-apps/*`, `/v1/tool-approvals/decision`, `/v1/feedback`, `/v1/conversations`, `/readiness`, `/liveness`, `/metrics`, `/authorized`.

## Removal

```bash
oc delete olsconfig cluster
oc delete secret credentials -n openshift-lightspeed
# operator stays installed; remove it with:
# oc delete csv -n openshift-lightspeed openshift-lightspeed
```

## Sizing notes

- OKP (Solr) requests **~75 GiB ephemeral storage**, 2 CPU / 2 GiB RAM by default; tunable via `spec.ols.deployment.rhokp`.
- The full stack (Solr + postgres + app server + MCP + otel) ran comfortably on `luke` (3 nodes: arbiter + 2 control-plane/worker); first-boot convergence took ~5 minutes.
