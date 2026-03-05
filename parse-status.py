import json, sys

d = json.load(sys.stdin)
print("SITREP v2 — Diagnostic multi-couche")
print("=" * 65)
for t in d["targets"]:
    di = t.get("diagnosis") or {}
    s = t["status"]
    e = t.get("error", "")
    name = t["name"]
    icon = t["icon"]
    if s == "OPERATIONAL":
        print(f"  OK  {icon} {name:25s} {s}")
    elif di.get("failedAt"):
        print(f"  ERR {icon} {name:25s} {s:12s} CAUSE: {di['failedAt']} -> {di['code']}")
        msg = di.get("message", "")[:90]
        print(f"      -> {msg}")
    else:
        print(f"  WRN {icon} {name:25s} {s:12s} err={e}")
print()
sm = d["summary"]
print(f"Summary: {sm['operational']} OK / {sm['degraded']} degraded / {sm['down']} down / {sm['total']} total")
