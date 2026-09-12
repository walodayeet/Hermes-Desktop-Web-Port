"""web-port streaming bench — attribute a perceived stream throttle with evidence.

Measures ONE real turn on the running web port (default http://localhost:4000)
over CDP and reports, separately:

  * send -> first delta (TTFT)            : where the pre-token time goes
  * delta arrival rate + payload sizes    : is the transport/delivery keeping up
  * DOM commit cadence (MutationObserver) : is React keeping up  <-- the throttle
  * in-stream long tasks (PerformanceObserver)
  * inbound events by name/bytes          : what else is on the socket

Verdict rule (this is the whole point of the tool):
  delta rate high + commit cadence ~= STREAM_DELTA_FLUSH_MS + in-stream long
  tasks negligible   => the renderer is NOT the throttle; look at the provider
  call / context size (backend logs: "API call #N ... latency=..s cache=..").
  commit cadence pinned near 250ms with >80ms in-stream long tasks
                     => the adaptive flush floor IS self-throttling.

Requires: python3 + `websockets`; a Chrome with --remote-debugging-port=9222
that is already logged in to the port (the port's login gate blocks fresh
sessions). Run it against a session the desktop does NOT currently own.

Usage:
  python3 scripts/stream-bench.py <sessionId> <label> [list|code]

The prompt is deterministic and long enough to sustain a real stream; the
script refuses to report a result unless the prompt actually left the socket
and deltas arrived.
"""

import asyncio
import json
import sys
import time
import urllib.request

import websockets

CDP = "http://127.0.0.1:9222"
ORIGIN = "http://localhost:4000"
SESSION = sys.argv[1] if len(sys.argv) > 1 else "20260820_102812_51ac57"
LABEL = sys.argv[2] if len(sys.argv) > 2 else "run"
MARK = "HDWB" + str(int(time.time()))[-5:]
# Deterministic, long enough to sustain a real stream. `code` exercises the
# worst case for a streaming renderer: ONE growing fenced block that is
# re-highlighted/re-parsed as it grows.
KIND = sys.argv[3] if len(sys.argv) > 3 else "list"
if KIND == "code":
    PROMPT = (f"Output ONE TypeScript code block (triple backticks, language ts) containing exactly 250 "
              f"lines, each `export const fN = (x: number) => x + N` for N=1..250 in order. "
              f"No other text, no commentary, no blank lines inside the block. ({MARK})")
else:
    PROMPT = (f"Output the integers from 1 to 1500, one per line, then the single line DONE. "
              f"No other text, no markdown. ({MARK})")

INSTRUMENT = r"""
(() => {
  const L = { t0: 0, sends: [], events: {}, msgs: [], big: [],
              deltas: 0, firstDelta: 0, lastDelta: 0, deltaSizes: [],
              inBytes: 0, outBytes: 0, promptSent: false };
  window.__hdl = L;
  const OrigWS = window.WebSocket;
  function evName(d) {
    const ms = d.match(/"(?:event|type)":\s*"([^"]+)"/g) || [];
    for (const m of ms) {
      const v = m.replace(/.*:\s*"/, '').replace(/"$/, '');
      if (v && v !== 'event' && v !== 'message') return v;
    }
    return '';
  }
  class WrappedWS extends OrigWS {
    constructor(...args) {
      super(...args);
      L.url = String(args[0]);
      this.addEventListener('message', ev => {
        const t = performance.now();
        const d = ev && ev.data;
        if (typeof d !== 'string') return;
        L.inBytes += d.length;
        const name = evName(d);
        const slot = L.events[name] || (L.events[name] = { n: 0, bytes: 0, max: 0 });
        slot.n++; slot.bytes += d.length;
        if (d.length > slot.max) slot.max = d.length;
        if (d.length > 15000 && L.big.length < 100) L.big.push([Math.round(t), name, d.length]);
        const isDelta = d.indexOf('message.delta') >= 0;
        if (isDelta) {
          L.deltas++;
          if (!L.firstDelta) L.firstDelta = t;
          L.lastDelta = t;
          if (L.deltaSizes.length < 3000) L.deltaSizes.push(d.length);
        }
        if (L.msgs.length < 5000) L.msgs.push([Math.round(t), d.length, isDelta ? 1 : 0, name]);
      });
    }
  }
  const origSend = OrigWS.prototype.send;
  WrappedWS.prototype.send = function (data) {
    try {
      const t = performance.now();
      const str = typeof data === 'string' ? data : '';
      L.sends.push([Math.round(t), str.length]);
      L.outBytes += str.length;
      if (window.__mark && str.indexOf(window.__mark) >= 0) L.promptSent = t;
    } catch (e) {}
    return origSend.apply(this, arguments);
  };
  window.WebSocket = WrappedWS;

  const raf = { n: 0, maxGap: 0, long: 0, longTotal: 0 };
  window.__raf = raf;
  let last = performance.now();
  (function loop() {
    const t = performance.now(); const g = t - last; last = t;
    raf.n++;
    if (g > raf.maxGap) raf.maxGap = g;
    if (g > 50) { raf.long++; raf.longTotal += g; }
    requestAnimationFrame(loop);
  })();

  // DOM-mutation truth: when did the UI actually change, and in how many bursts
  L.mut = []; L.mutBursts = 0; L.lastMut = 0;
  const mo = new MutationObserver(list => {
    const t = performance.now();
    let added = 0;
    for (const m of list) {
      if (m.type === 'characterData') added += (m.target.data || '').length;
      for (const n of m.addedNodes) added += (n.textContent || '').length;
    }
    L.mut.push([Math.round(t), added, list.length]);
    L.lastMut = t;
  });
  const attachMo = () => {
    try {
      if (!document.body) return false;
      mo.observe(document.body, { subtree: true, childList: true, characterData: true });
      L.moAttached = true;
      return true;
    } catch (e) { L.moErr = String(e); return false; }
  };
  if (!attachMo()) {
    document.addEventListener('DOMContentLoaded', attachMo, { once: true });
    setTimeout(attachMo, 1000);
    setTimeout(attachMo, 3000);
  }

  // long tasks, bucketed by second, for main-thread attribution
  L.lt = [];
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) L.lt.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}

  const paint = { s: [] };
  window.__paint = paint;
  setInterval(() => {
    let n = 0;
    try {
      // cheap: the composer/transcript scroll container's text length
      n = document.body ? document.body.innerText.length : 0;
    } catch (e) {}
    paint.s.push([Math.round(performance.now()), n]);
  }, 250);
})()
"""


def http_json(p):
    with urllib.request.urlopen(CDP + p, timeout=10) as r:
        return json.load(r)


async def main():
    bws = http_json("/json/version")["webSocketDebuggerUrl"]
    async with websockets.connect(bws, max_size=256 * 1024 * 1024) as B:
        n = 0

        async def call(ws, m, p=None, t=45):
            nonlocal n
            n += 1
            await ws.send(json.dumps({"id": n, "method": m, "params": p or {}}))
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), t))
                if msg.get("id") == n:
                    return msg

        await call(B, "Target.createTarget", {"url": f"{ORIGIN}/#{SESSION}"})
        await asyncio.sleep(2)
        page = next((t for t in http_json("/json") if SESSION in (t.get("url") or "")), None) \
            or next(t for t in http_json("/json") if (t.get("url") or "").startswith(ORIGIN))

        async with websockets.connect(page["webSocketDebuggerUrl"], max_size=256 * 1024 * 1024) as ws:
            await call(ws, "Runtime.enable")
            await call(ws, "Page.enable")
            await call(ws, "Page.addScriptToEvaluateOnNewDocument", {"source": INSTRUMENT})
            await call(ws, "Page.reload", {})

            async def js(e, ap=False, t=45):
                r = await call(ws, "Runtime.evaluate", {"expression": e, "returnByValue": True,
                                                       "userGesture": True, "awaitPromise": ap}, t)
                res = r.get("result", {}).get("result", {})
                if res.get("subtype") == "error":
                    return {"__error__": (res.get("description") or "")[:300]}
                return res.get("value")

            async def jsj(e, ap=False, t=45):
                v = await js(e, ap, t)
                if isinstance(v, str):
                    try:
                        return json.loads(v)
                    except Exception:
                        return {"__raw__": v[:300]}
                return v if isinstance(v, dict) else {"__none__": str(v)[:150]}

            # boot: wait for instrumentation + composer, then settle
            for _ in range(50):
                b = await jsj("JSON.stringify({h: !!window.__hdl, "
                              "cands: [...document.querySelectorAll('[contenteditable=true]')].length,"
                              "txt: !!document.querySelector('textarea')})")
                if b.get("h") and (b.get("cands", 0) > 0 or b.get("txt")):
                    break
                await asyncio.sleep(1)
            print("BOOT:", b)
            if not b.get("h"):
                print("ABORT: instrumentation missing")
                return
            await asyncio.sleep(6)

            # pick the composer: the contenteditable that is NOT the sidebar search
            picks = await jsj("""
            (() => {
              const els = [...document.querySelectorAll('[contenteditable=true]')];
              return JSON.stringify(els.map((el, i) => {
                const r = el.getBoundingClientRect();
                return {i, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
                        ph: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') ||
                            el.getAttribute('aria-label') || '',
                        w: Math.round(r.width), h: Math.round(r.height),
                        bottom: Math.round(window.innerHeight - r.bottom)};
              }));
            })()
            """)
            print("CANDIDATES:", picks)
            if not isinstance(picks, list) or not picks:
                print("ABORT: no contenteditable")
                return
            # composer heuristic: lowest on screen + widest
            best = sorted(picks, key=lambda p: (-p["bottom"], -p["w"]))[0]
            print("CHOSEN:", best)

            for typ in ("mousePressed", "mouseReleased"):
                await call(ws, "Input.dispatchMouseEvent",
                           {"type": typ, "x": best["x"], "y": best["y"], "button": "left", "clickCount": 1})
            await asyncio.sleep(0.5)
            await js(f"window.__mark = {json.dumps(MARK)}; 'm'")
            await call(ws, "Input.insertText", {"text": PROMPT})
            await asyncio.sleep(0.7)
            check = await jsj("""
            JSON.stringify({typed: [...document.querySelectorAll('[contenteditable=true]')]
              .map(e => (e.textContent||'').indexOf(window.__mark) >= 0)})
            """)
            print("TYPED-INTO:", check)
            if not any(check.get("typed") or []):
                print("ABORT: prompt not in any composer")
                return

            await js("window.__hdl.t0 = performance.now(); window.__hdl.sends.length = 0;"
                     "window.__hdl.msgs.length = 0; window.__hdl.events = {}; window.__hdl.big.length = 0;"
                     "window.__hdl.deltas = 0; window.__hdl.firstDelta = 0; window.__hdl.lastDelta = 0;"
                     "window.__hdl.deltaSizes.length = 0; window.__paint.s.length = 0;"
                     "window.__hdl.promptSent = false;"
                     "window.__raf.n = 0; window.__raf.maxGap = 0; window.__raf.long = 0;"
                     "window.__raf.longTotal = 0; window.__hdl.mut.length = 0;"
                     "window.__hdl.lastMut = 0; window.__hdl.lt.length = 0; 'ok'")

            await call(ws, "Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter",
                                                     "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})
            await call(ws, "Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter",
                                                     "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})
            print("ENTER PRESSED")

            # confirm the prompt left over the socket
            sent = False
            for _ in range(20):
                await asyncio.sleep(1)
                st = await jsj("JSON.stringify({p: !!window.__hdl.promptSent, d: window.__hdl.deltas,"
                               " s: window.__hdl.sends.length})")
                if st.get("p"):
                    sent = True
                    print("SEND CONFIRMED at", st)
                    break
            if not sent:
                print("ABORT: prompt never left the socket —", st)
                return

            # wait for deltas to start
            started = False
            for _ in range(60):
                await asyncio.sleep(1)
                d = await js("window.__hdl.deltas")
                if isinstance(d, int) and d > 0:
                    started = True
                    break
            print("DELTAS STARTED:", started)
            if not started:
                print("no deltas within 60s")

            deadline = time.time() + 240
            lastn, quiet = -1, 0
            while time.time() < deadline:
                await asyncio.sleep(2)
                cur = await js("window.__hdl.deltas")
                if isinstance(cur, int) and cur == lastn and cur > 0:
                    quiet += 2
                    if quiet >= 8:
                        break
                else:
                    quiet = 0
                lastn = cur if isinstance(cur, int) else lastn

            d = await jsj("JSON.stringify({hdl: window.__hdl, raf: window.__raf, paint: window.__paint.s})")
            if "hdl" not in d:
                print("ABORT: no dump", d)
                return
            h, raf, paint = d["hdl"], d["raf"], d["paint"]
            t0 = h["t0"]
            first = h["firstDelta"] - t0 if h["firstDelta"] else 0
            lastd = h["lastDelta"] - t0 if h["lastDelta"] else 0
            span = (lastd - first) / 1000.0 if lastd > first else 0
            ev = dict(sorted(((k or "(none)", v) for k, v in h["events"].items()),
                             key=lambda kv: -kv[1]["bytes"])[:8])
            win = [p for p in paint if t0 + first <= p[0] <= t0 + lastd + 1500]
            painted = (win[-1][1] - win[0][1]) if len(win) >= 2 else None
            pspan = (win[-1][0] - win[0][0]) / 1000.0 if len(win) >= 2 else 0
            ds = h["deltaSizes"] or [0]
            print("RESULT:", json.dumps({
                "label": LABEL, "session": SESSION,
                "send_to_first_delta_ms": round(first),
                "stream_span_s": round(span, 2),
                "delta_count": h["deltas"],
                "delta_rate_per_s": round(h["deltas"] / span, 1) if span else None,
                "delta_payload_avg_B": round(sum(ds) / len(ds), 1),
                "in_total_KB": round(h["inBytes"] / 1024, 1),
                "out_total_KB": round(h["outBytes"] / 1024, 1),
                "out_sends": len(h["sends"]),
                "painted_chars": painted,
                "painted_chars_per_s": round(painted / pspan, 0) if (painted and pspan) else None,
                "raf_fps_stream_window": round(raf["n"] / (span or 1), 1),
                "raf_max_gap_ms": round(raf["maxGap"], 1),
                "raf_long_frames": raf["long"],
                "raf_long_total_ms": round(raf["longTotal"], 0),
                "events_by_bytes": ev,
            }, indent=1))
            print("BIG_EVENTS (ms/name/KB):",
                  json.dumps([[int(t - t0), nm, int(b // 1024)] for t, nm, b in h["big"][:30]]))
            per = {}
            for ts, ln, isd, nm in h["msgs"]:
                sec = int((ts - t0) / 1000)
                b = per.setdefault(sec, [0, 0])
                b[0] += isd
                b[1] += ln
            print("PER_SEC (sec: [deltas, bytes]):", json.dumps({k: v for k, v in sorted(per.items())}))

            # ---- drain lag + flush cadence -------------------------------------
            # ---- DOM truth: last UI change vs last delta --------------------
            muts = [[int(t - t0), a, n] for t, a, n in h.get('mut', []) if t >= t0]
            lastmut = (h['lastMut'] - t0) if h.get('lastMut') else None
            buckets = {}
            for t, a, n in muts:
                sec = t // 1000
                b = buckets.setdefault(sec, [0, 0])
                b[0] += 1
                b[1] += a
            bursts = [k for k, v in sorted(buckets.items()) if v[1] > 0]
            gaps = [bursts[i] - bursts[i-1] for i in range(1, len(bursts))] if len(bursts) > 1 else []
            lts = [[int(t - t0), d] for t, d in h.get('lt', []) if t >= t0]
            in_stream_lt = [x for x in lts if first <= x[0] <= (lastd - first) + first + 2000]
            print("DOM_TRUTH: mut_records=%d seconds_with_growth=%d last_ui_change_ms=%s moAttached=%s"
                  % (len(muts), len(bursts), lastmut, h.get('moAttached')))
            # true commit cadence: gaps between consecutive mutation records (ms)
            if len(muts) > 3:
                mg = [muts[i][0] - muts[i-1][0] for i in range(1, len(muts))]
                mgs = sorted(mg)
                print("COMMIT_CADENCE_MS: n=%d p50=%d p90=%d p99=%d max=%d"
                      % (len(mg), mgs[len(mgs)//2], mgs[int(len(mgs)*0.9)], mgs[int(len(mgs)*0.99)], mgs[-1]))
                in_stream_mg = [muts[i][0] - muts[i-1][0] for i in range(1, len(muts))
                                if first <= muts[i][0] <= lastd]
                if in_stream_mg:
                    sm = sorted(in_stream_mg)
                    print("COMMIT_CADENCE_IN_STREAM: n=%d p50=%d p90=%d"
                          % (len(sm), sm[len(sm)//2], sm[int(len(sm)*0.9)]))
                tail = [m[0] for m in muts if m[0] > lastd]
                print("MUT_AFTER_LAST_DELTA: n=%d  last=%sms after"
                      % (len(tail), (tail[-1] - lastd) if tail else None))
            if lastmut:
                print("DRAIN_LAG_mut_ms = %s (last UI change - last delta)"
                      % round(lastmut - lastd))
                print("PERCEIVED_delta_per_s = %.1f  (deltas / (last UI change - send))"
                      % (h['deltas'] / ((lastmut - first) / 1000.0) if lastmut > first else -1))
            print("UI_CHANGE_GAP_S: median=%s max=%s"
                  % (sorted(gaps)[len(gaps)//2] if gaps else None, max(gaps) if gaps else None))
            print("LONGTASK: n=%d total_ms=%d max_ms=%d  (in-stream n=%d total_ms=%d)"
                  % (len(lts), sum(d for _, d in lts), max([d for _, d in lts], default=0),
                     len(in_stream_lt), sum(d for _, d in in_stream_lt)))
            print("LONGTASK_PER_SEC:", json.dumps({t // 1000: d for t, d in lts}))

            ps = [p for p in paint if p[0] >= t0]
            growth = []
            for i in range(1, len(ps)):
                d = ps[i][1] - ps[i-1][1]
                if d > 0:
                    growth.append([ps[i][0] - t0, d])
            last_growth = growth[-1][0] if growth else None
            stream_end = lastd
            print("DRAIN: last_delta_ms=%s last_paint_growth_ms=%s drain_lag_ms=%s"
                  % (round(stream_end), round(last_growth) if last_growth else None,
                     round(last_growth - stream_end) if last_growth else None))
            steps = [g[0] for g in growth]
            gaps = [steps[i] - steps[i-1] for i in range(1, len(steps))]
            gaps_sorted = sorted(gaps)
            if gaps:
                print("FLUSH_CADENCE: n=%d median_ms=%d p90_ms=%d max_ms=%d"
                      % (len(gaps), gaps_sorted[len(gaps_sorted)//2],
                         gaps_sorted[int(len(gaps_sorted)*0.9)], gaps_sorted[-1]))
            # growth during the stream window only
            win_growth = [g for g in growth if first <= g[0] <= stream_end]
            print("PAINT_STEPS_TOTAL=%d IN_STREAM=%d POST_STREAM=%d"
                  % (len(growth), len(win_growth), len(growth) - len(win_growth)))
            chars_arrived = sum(ds)
            print("DELTA_CHARS_vs_PAINTED: arrived_payload_B=%s painted_chars=%s"
                  % (chars_arrived, painted))

        await call(B, "Target.closeTarget", {"targetId": page["id"]})


asyncio.run(main())
