# Diagnosis — desktop / web-port streaming slowness

Brief: `/tmp/web-port-slowness-brief.md` (2026-09-09). Re-measured 2026-09-12 on
deployed bundle `index-2vXhvYAy.js`, live web port `:4000`, real turns in the
172–181-message session `20260820_102812_51ac57`.

## Verdict

**The per-delta websocket → React render is NOT the throttle.** The brief's
premise is refuted by measurement. Rendering is idle during streams, the flush
floor is never engaged, and the browser's total turn time matches the backend's
own recorded turn duration. The turn cost is the provider call on a ~140K-token
context, and its time-to-first-token dominates.

No renderer change was shipped. A speculative change here would touch a hot path
that is measurably keeping up, and would be indistinguishable from a regression —
the same reason the earlier composer-fade attempt made flicker 5× worse.

## Measurements (six real turns, `scripts/stream-bench.py`)

| prompt | TTFT | deltas | arrival | in-stream long tasks | DOM commit cadence p50 |
|---|---|---|---|---|---|
| 1..300 | 12.2 s | 302 | 80.7 /s | — | — |
| 1..1500 | 11.7 s | 1752 | 77.3 /s | 1 task, 56 ms | — |
| 1..1500 | 19.9 s | 1752 | 85.7 /s | — | — |
| 250-line TS code block | 14.3 s | 2002 | 82.9 /s | 3 tasks, 377 ms | — |
| 250-line TS code block | 14.0 s | 2002 | 81.5 /s | 2 tasks, 103 ms | 30 ms |
| 250-line TS code block | 19.5 s | 3759 | 159.2 /s | 3 tasks, 205 ms | 28 ms |

What each column settles:

1. **Deltas arrive at the model's own emission rate** (77–159/s). 1 delta ≈ 1
   token; payloads are `{"text": chunk}` (delta event avg 142 B, of which ~5 B
   is text — the rest is the per-event envelope).
2. **React keeps up.** In-stream DOM commit cadence p50 = 28–30 ms — exactly
   `STREAM_DELTA_FLUSH_MS = 33`, i.e. ~33 fps of visible text growth. The
   adaptive floor (`max(33 ms, lastFlushCost × 3)` capped at
   `MAX_STREAM_FLUSH_GAP_MS = 250`) never engages for a single stream, because
   the cost term would need ≥83 ms per flush to reach the cap.
3. **Main thread is idle while streaming**: 0.1–0.4 s of long tasks across
   24 s of streaming (≤1.6% duty), *including* the worst case for a renderer —
   one growing 250-line fenced code block that must be re-parsed as it grows.
   The earlier "flush cadence pinned at 250 ms" reading in this file's history
   was an artifact of a 250 ms paint sampler; the MutationObserver cadence
   above is the real number.
4. **The client adds ~0–5%**: backend `tui turn finished: ... duration=36.9s`
   vs the browser's own end-to-end ≈38 s; `duration=44.2s` vs ≈46 s.
5. **TTFT (12–20 s) happens inside the provider call**, before any delta
   exists. The backend's own per-call line for a bench turn:

   ```
   API call #5: model=deepseek-v4-flash provider=custom in=140350 out=3529
   total=143879 latency=30.2s cache=135168/140350 (96%)
   Turn ended: reason=text_response(finish_reason=stop) api_calls=1/150 ...
   tui turn finished: ... duration=36.9s
   ```

   One call, 30.2 s, 96% cache hit → generation ran at ~117 tok/s, matching the
   brief's own "upstream 101–115 tok/s". The turn's 36.9 s = ~2.5 s inline
   context compression + 30.2 s call + ~4 s persist/trim. The client's pre-send
   work is <1 s of that.

## Why the brief's 3–4× reading was an apples-to-oranges comparison

- The desktop figure (~20 tok/s) is **output tokens ÷ end-to-end turn wall
  time** — TTFT included, and a turn may make several provider calls.
- The CLI figure (60–75 tok/s) is **generation rate** with prefill excluded
  (the brief's own note: "764 tok / 19.6 s incl 34K cold prefill").
- Same model call measured on the wire: ~117 tok/s generation. Nothing on the
  delivery path is 3–4× slow.

## Where the time actually goes (ranked, with the lever for each)

1. **Provider TTFT on a ~140K-token prompt: 12–20 s per call** — dominant, and
   it lands before the first delta. Lever: reduce per-turn context (compression
   thresholds / session hygiene), or a provider with faster prefill.
2. **Number of provider calls per turn** — a turn with tool calls multiplies
   both TTFT and wall time; the backend log's `api_calls=N/150` is the number to
   watch (`tool_turns=68` on this session). Lever: fewer tool round-trips.
3. **Inline context compression: ~2.5 s** when it fires mid-turn.
4. **Delivery/render: ≤1.6% of a 24 s stream.** Nothing to win here.

## Reproducing this

`scripts/stream-bench.py` (port-local tooling, not upstream-synced):

```bash
python3 scripts/stream-bench.py <sessionId> <label> [list|code]
```

Needs python3 + `websockets` and a Chrome running with
`--remote-debugging-port=9222` already logged in to the port (the login gate
blocks fresh sessions). It refuses to report unless the prompt actually left
the socket and deltas arrived. Pair the result with the backend's own lines:

```bash
grep -E "API call #|tui turn finished" ~/.hermes/logs/agent.log | tail -5
```

## Open item

The one measurement this lane could not complete: a same-prompt **small vs big
session** A/B to quantify how much of the 12–20 s TTFT is context size vs
provider baseline. It needs a session the desktop does not currently own — the
CLI refuses with `SESSION_NOT_OWNED` while the desktop holds the lease:
`Refused active session 20260820_102812_51ac57: already held by pid=3764484
surface=desktop`.
