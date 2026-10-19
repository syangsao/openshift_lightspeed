# OpenShift Lightspeed with a locally served LLM

Deployment notes for **Red Hat OpenShift Lightspeed 1.0** on the `luke` OpenShift cluster, pointing at a **local llama.cpp server** instead of a cloud LLM provider. Includes verified configuration, the exact commands used, and every issue hit along the way (with root causes and upstream references).

| Component | Detail |
|---|---|
| Cluster | `luke` — OCP 4.22, Kubernetes v1.35.6, RHCOS 9.8 |
| Topology | **3 nodes**: 1 arbiter (`192.168.40.25`) + 2 control-plane/worker (`192.168.40.26`, `.27`). This is **not** a single-node (SNO) cluster. |
| API | `https://api.luke.syangsao.net:6443` |
| Lightspeed | 1.0, operator installed via OLM (`openshift-lightspeed` namespace) |
| LLM | llama.cpp (`ghcr.io/ggml-org/llama.cpp`, build 11669), `Qwen3.8-27B UD-IQ4_XS`, 262K ctx |
| LLM transport | `ols-shim` (Responses-API compatibility proxy) `:8023` → llama.cpp `:8022` — see [manifests/llama-cpp-responses-shim.md](manifests/llama-cpp-responses-shim.md) |
| LLM endpoint | `http://192.168.40.100:8023/v1` (shim; direct llama.cpp is `:8022`) |
| Provider type | `openai` (OpenAI-compatible API) |
| Status | ✅ RAG/docs answers and MCP cluster-interaction tool calls verified end-to-end (2026-10-19); console in use |

> ⚠️ The LLM URL and hostnames below are from the reference environment; substitute your own.

## Operational status

Running in production use as of **2026-10-19**. Verified paths: console chat, RAG/docs answers, MCP cluster interaction (`resources_list`, `pods_list`, …), streaming queries.

Known limitations of this deployment:

| Limitation | Impact | Mitigation |
|---|---|---|
| llama.cpp `500` on **parallel tool calls** ([issue #7](docs/issues.md#7-danger-alert-llm-backend-an-error-occurred-during-llm-invocation)) | “LLM invocation” danger alert; the corrupt call is replayed and wedges the chat | **Fixed** with the `ols-shim` Responses-API proxy (`output_index` injection). Chats wedged before the fix still need a new conversation. Upstream #20607/#25510 remain open. |
| Tool-result safety inspection **disabled** ([issue #2](docs/issues.md#2-tool-result-safety-inspection-fails-closed--tool-result-failed-the-safety-inspection)) | No prompt-injection scanning of tool output | Acceptable for trusted sources (Red Hat docs via OKP, local MCP server); re-enable with a model that emits strict JSON |
| Thinking disabled server-side ([issue #1](docs/issues.md#1-tool-calling-queries-fail-with-http-400-itemcontent-is-empty)) | No `reasoning_content`; instruct sampler | Restore with `ENABLE_THINKING=true` once llama.cpp #29412 lands |
| Model reliability | One observed hallucination (invented node names/count) | Verify cluster-mutating answers; Qwen3.8-27B is good, not flawless at tool use |

## Architecture

```mermaid
flowchart LR
    U[User] -->|web console| CP[Console plugin]
    CP -->|"HTTPS :8443<br/>/v1/query"| AS[Lightspeed<br/>app-server]
    AS -->|RAG| SOLR[RHOKP / Solr<br/>portal-rag core]
    AS -->|MCP tools| MCP[openshift-mcp-server]
    MCP --> K8S[Cluster API]
    AS -->|"OpenAI-compatible<br/>/v1/responses"| SHIM[ols-shim :8023]
    SHIM -->|patched SSE| LLM[llama.cpp<br/>192.168.40.100:8022]
    AS --> PG[(PostgreSQL<br/>conversation cache)]
    AS --> OTEL[OTel collector]
```

## Quick start

```bash
# 1. Secret (placeholder token; llama.cpp needs no auth but the field is required)
oc create -f manifests/secret.yaml

# 2. OLSConfig
oc create -f manifests/olsconfig.yaml

# 3. Watch the rollout (images pull, then Solr warms up — first boot takes ~5-15 min)
oc get pods -n openshift-lightspeed -w
```

Full procedure, including CLI verification with a real OAuth token: [docs/setup.md](docs/setup.md).

Issue log with root causes and upstream links: [docs/issues.md](docs/issues.md).

## Verified behaviour

| Query | Path exercised | Result |
|---|---|---|
| "What is a SNO OpenShift cluster? Answer in one sentence." | RAG (Solr) + docs tool | Correct answer, 5 `referenced_documents` |
| "How many nodes are in my cluster? Name them." | MCP cluster tool (`resources_list`) | Correct 3-node table with IPs |

See [docs/verification.md](docs/verification.md) for exact commands and outputs.

## Layout

```
manifests/
  olsconfig.yaml               # OLSConfig CR (provider, model, guardrails)
  secret.yaml                  # apitoken secret
  llama-cpp-compose-change.md  # server-side change to llama.cpp compose + revert
  llama-cpp-responses-shim.md  # Responses-API compatibility proxy (deploy/remove)
  shim/proxy.mjs               # pinned copy of the shim (MIT, upstream linked)
docs/
  setup.md                     # step-by-step deployment and testing
  issues.md                    # issue log: symptoms, root cause, status, workaround
  verification.md              # smoke tests and observed outputs
```
