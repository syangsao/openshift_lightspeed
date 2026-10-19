# llama.cpp compose change (server side)

Lightspeed requires the llama.cpp server to run with **thinking disabled**; otherwise every tool-calling query fails with a 400 (issue #1 in [../docs/issues.md](../docs/issues.md)).

## Change

File: `club-3090/models/qwen3.8-27b/llama-cpp/compose/single/unsloth-iq4xs/q4kv-vision.yml`

```diff
       - INSTRUCT
-      - ENABLE_THINKING
+      # OpenShift Lightspeed (OLS 1.0) replays the `reasoning` history item it
+      # receives on the second /v1/responses call; the llama.cpp build pinned here
+      # rejects empty reasoning input items (400), so tool-calling queries die.
+      # Default to the INSTRUCT row (reasoning off) until ggml-org/llama.cpp#29159
+      # is merged. Host env still wins: ENABLE_THINKING=true restores thinking.
+      - ENABLE_THINKING=${ENABLE_THINKING:-false}
```

The club-3090 entrypoint treats `ENABLE_THINKING=false` as “select the INSTRUCT row”: `--reasoning off` plus the instruct sampler (`temp 0.7 / top_p 0.80 / presence 1.5`).

## Apply

```bash
cd club-3090/models/qwen3.8-27b/llama-cpp/compose/single/unsloth-iq4xs
docker compose -f q4kv-vision.yml \
  -f ~/.local/share/club-3090/compose-labels/llamacpp-qwen38-27b-single-iq4xs.yml \
  up -d --force-recreate llama-cpp-qwen38-27b-single
```

Verify:

- boot log: `[sampler] INSTRUCT row: reasoning=off temp=0.7 top_p=0.80 presence=1.5`
- `curl -s localhost:8022/v1/models` lists `qwen3.8-27b` (~20 s reload)
- chat completions have no `reasoning_content`

Before recreating, confirm the rendered config still matches the live container (name/port/mount/image in this environment are the compose defaults):

```bash
docker compose ... config   # container_name, ports, volumes
docker inspect llama-cpp-qwen38-27b-single --format '{{range .Mounts}}{{.Source}}->{{.Destination}}{{"\n"}}{{end}}'
```

## Revert

Restore thinking (once the upstream fix lands, or if thinking matters more than Lightspeed tool calls):

```bash
ENABLE_THINKING=true docker compose ... up -d --force-recreate llama-cpp-qwen38-27b-single
```

or remove the edit from the compose file.

**Scope:** this changes the model's behaviour for *everything* using this endpoint (no `reasoning_content`, instruct sampler), not just Lightspeed.
