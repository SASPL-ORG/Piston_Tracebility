# Tool Life → PLC Lockout Bit

End-to-end contract that takes a Tool Life exhaustion event in the Piston
Traceability app and lands it as a latched bit in the PLC. Three boxes
are involved:

```
┌──────────────┐      ┌──────────────┐      ┌─────────────────┐
│  Browser     │ POST │  Backend     │ POST │  Node-RED       │ S7-WRITE
│  (Maintenance│ ───► │  /tool-life/ │ ───► │  SAM_Full_Flow  │ ─────────► PLC
│   page)      │      │  notify-     │      │                 │            DB1000.DBX682.0 = TRUE
│              │      │  exhausted   │      │                 │
└──────────────┘      └──────────────┘      └─────────────────┘
```

Backend ↔ Node-RED: this repo. Node-RED ↔ PLC: belongs to the PLC engineer.

---

## Confirmed PLC target

| Field    | Value                          |
|----------|--------------------------------|
| Address  | `DB1000.DBX682.0`              |
| Tag name | `Tool Life Count Reached` (Bool) |
| Semantics | Set TRUE (1) when any tool's life is exhausted. **Latched** — PLC owns the reset. |

**The app NEVER writes FALSE.** When the operator resets a tool in the Maintenance UI, the app just stops sending the exhausted signal for that tool. Clearing the bit is a PLC-side concern (manual push-button, sequence-complete, whatever the engineer wires).

---

## What the backend sends to Node-RED

`POST <NODE_RED_TOOL_LIFE_WEBHOOK_URL>` with this exact body:

```json
{
  "source":        "piston-traceability",
  "event":         "tool_life_exhausted",
  "tool_name":     "Snap Ring Pusher Shaft",
  "quantity_left": 0,
  "timestamp":     "2026-06-17T13:33:15.123Z"
}
```

Headers:
- `Content-Type: application/json`
- `Authorization: Bearer <token>` — only if `NODE_RED_WEBHOOK_TOKEN` is set in [.env](.env)

`tool_name` is the spare-name string the operator sees in the Tool Life table. Possible values today (13 spares):

```
Snap Ring Pusher Shaft       Rail Ring Pusher
Snap Ring Holder Shaft        Rail Ring Top Plates
Snap Ring Slider              Top Ring Pusher
Expander Ring Opening Jaws    Top Ring Plates
Expander Ring Pusher          2nd Ring Pusher
Expander Ring Top Plates      2nd Ring Plates
Rail Ring Opening Jaws
```

---

## Node-RED flow — what the engineer wires

Required behaviour:

1. **HTTP-In node** at `/tool-life-exhausted` (POST). The URL in [.env](.env)'s `NODE_RED_TOOL_LIFE_WEBHOOK_URL` must reach this node.
2. **HTTP-Response node** returning 200 **immediately**, before anything else. The backend has a 5-second timeout; if NR doesn't ack fast, the backend retries on the next exhaustion poll.
3. **Function node** that prepares the write payload. Reads the target address from the env var `PLC_TOOL_LIFE_LOCKOUT_ADDR`, falling back to the confirmed default `DB1000.DBX682.0`:
   ```javascript
   // Pull the address from NR's environment so ops can rotate it
   // without re-deploying the flow. Default matches the PLC engineer's
   // confirmed target.
   const addr = env.get('PLC_TOOL_LIFE_LOCKOUT_ADDR') || 'DB1000.DBX682.0';

   // ONLY ever write TRUE. The bit is latched — the PLC clears it.
   return {
       payload:  true,
       variable: addr,        // for node-red-contrib-s7 (named or dynamic)
       address:  addr,        // for node-red-contrib-snap7 (dynamic addr)
       topic:    addr,        // some packages key off topic
       tool:     msg.payload.tool_name,
       timestamp: msg.payload.timestamp,
   };
   ```
4. **S7-OUT node** on the **same S7 connection** the rest of the flow already uses to READ DB1000 (the Ring_Log / Circlip_DMC reader). **Do not create a second connection** — reuse the one that's already proven working.

   Address syntax must match whatever your existing READ nodes use for DB1000. Common conventions:
   - `node-red-contrib-s7`:      variable defined on the S7 endpoint with address `DB1000,X682.0`, written by name via `msg.variable`
   - `node-red-contrib-snap7`:   `DB1000.DBX682.0` written via `msg.address` or as a configured area on the OUT node
   - Beckhoff / other libs:     match their convention; the function node above exposes the address on three common keys (`variable`, `address`, `topic`) so one of them will route correctly

5. **Debug node** off the function-node output (set to "complete msg") — keeps a verification trail without affecting the write.

---

## Importable starter flow

Paste this into Node-RED → Menu → Import. It gives you a working scaffold; you swap the `[S7-OUT-PLACEHOLDER]` node for your real S7-OUT node, wired to the existing S7 connection on the flow.

```json
[
    {
        "id": "tl-http-in",
        "type": "http in",
        "name": "tool-life-exhausted",
        "url": "/tool-life-exhausted",
        "method": "post",
        "wires": [["tl-http-res", "tl-build-write"]]
    },
    {
        "id": "tl-http-res",
        "type": "http response",
        "name": "ack 200",
        "statusCode": "200",
        "wires": []
    },
    {
        "id": "tl-build-write",
        "type": "function",
        "name": "Build S7 write payload",
        "func": "// Address comes from NR env PLC_TOOL_LIFE_LOCKOUT_ADDR\n// (default DB1000.DBX682.0 = tag 'Tool Life Count Reached', confirmed by PLC engineer).\n// Bit is LATCHED — PLC owns the reset. Never write FALSE.\nconst addr = env.get('PLC_TOOL_LIFE_LOCKOUT_ADDR') || 'DB1000.DBX682.0';\n\nreturn {\n    payload:   true,\n    variable:  addr,\n    address:   addr,\n    topic:     addr,\n    tool:      msg.payload && msg.payload.tool_name,\n    timestamp: msg.payload && msg.payload.timestamp\n};\n",
        "outputs": 1,
        "wires": [["tl-debug", "tl-s7-out"]]
    },
    {
        "id": "tl-debug",
        "type": "debug",
        "name": "write event",
        "active": true,
        "complete": "true",
        "wires": []
    },
    {
        "id": "tl-s7-out",
        "type": "comment",
        "name": "[S7-OUT-PLACEHOLDER] wire to existing DB1000 S7 connection. Address = msg.variable / msg.address / msg.topic. Value = msg.payload (true).",
        "info": "Replace this comment node with your real S7-OUT node configured against the SAM_Full_Flow S7 connection. Address syntax must match the existing READ nodes for DB1000.",
        "wires": []
    }
]
```

Steps after import:
1. Replace the `[S7-OUT-PLACEHOLDER]` comment node with an S7-OUT node from whichever S7 package the flow already uses.
2. Wire `Build S7 write payload` → your real S7-OUT node.
3. Configure the S7-OUT node to use the same connection profile as the existing DB1000 reader.
4. Set the S7-OUT node's address from `msg.variable` (or `msg.address` / topic, whichever your package supports for dynamic addressing). If your package only allows a fixed configured address, set it to `DB1000.DBX682.0` literally and ignore the function node's address field.

---

## Setting the env var on the Node-RED host

In NR's `settings.js`:
```javascript
process.env.PLC_TOOL_LIFE_LOCKOUT_ADDR = 'DB1000.DBX682.0';
```

Or as a systemd unit env line, or as a Docker `-e` flag — anywhere Node-RED's process sees it. Function nodes read it via `env.get('PLC_TOOL_LIFE_LOCKOUT_ADDR')`.

Default is `DB1000.DBX682.0` if the var is unset — so it works out of the box, the env var is only there for future rotation.

---

## Acceptance test

From the SCADA box's PowerShell, fire a synthetic exhaustion:

```powershell
curl.exe -sS -X POST http://localhost:8080/api/tool-life/notify-exhausted `
  -H "Content-Type: application/json" `
  -d '{"tool_name":"Snap Ring Pusher Shaft","quantity_left":0}'
```

Expected:

| Where | What to see |
|---|---|
| **curl response** | `{"ok":true,"dispatched":true,"webhookStatus":200}` |
| **Node-RED debug sidebar** | The JSON above, plus `payload: true` and `variable: "DB1000.DBX682.0"` |
| **PLC** | `Tool Life Count Reached` (DB1000.DBX682.0) reads TRUE |
| **PLC** | Stays TRUE after subsequent test fires (latched). Only the PLC's reset path can clear it. |

If you fire the same tool twice within 60 seconds, the backend dedupes — the second call returns `{"dispatched":false,"dedupedAgainstAt":"..."}` and Node-RED is not hit. This is intentional; it protects the PLC from chatter when multiple browsers are open. Wait 60 s between repeat tests, or fire a *different* `tool_name`.

---

## Reset semantics — what to tell operators

> "When the lockout bit goes TRUE, the line stops. To clear it, the maintenance operator (a) physically replaces the spare, (b) opens the Maintenance page, (c) hits Reset on the affected Tool Life row, and (d) hits the PLC reset push-button. The order of c and d doesn't matter — both are required."

The app does NOT clear the bit when Reset is hit. That's the PLC engineer's reset path.

---

## Common gotchas

- **Address syntax differs by S7 package.** `DB1000.DBX682.0` (Siemens convention), `DB1000,X682.0` (`node-red-contrib-s7` convention), `DB1000.DBX682.0` again for snap7. Match the syntax of your existing READ nodes for DB1000 — that's the one your active S7 package understands.
- **The function node never sees `msg.payload.tool_name` if the HTTP-In's "Return" mode is set to `a UTF-8 string` instead of `a parsed JSON object`.** Open the HTTP-In node config and ensure Return = `a parsed JSON object`.
- **Wiring the S7-OUT BEFORE the HTTP-Response** would mean the backend sees its 5-second timeout fire while NR is waiting on the PLC. Always: HTTP-In → HTTP-Response (ack first), and HTTP-In → function → S7-OUT (do work in parallel).
- **One-shot per Life value.** The backend stamps a per-tool flag on the first exhaustion; subsequent polls don't re-fire for the same (tool, Life-value) pair. To force a re-test, the operator must Reset the tool in the UI, then re-enter a Life value — that clears the flag.
