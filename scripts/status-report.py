#!/usr/bin/env python3
"""Quick CLI status report from SITREP API."""
import json, sys, urllib.request

url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3333/api/status"
data = json.loads(urllib.request.urlopen(url).read())

print(f"Date:  {data['timestamp']}")
print(f"Poll:  {data['pollInterval']}ms")
s = data["summary"]
print()
print("=" * 72)
print(f"  TOTAL: {s['total']}  |  UP: {s['operational']}  |  DEGRADED: {s['degraded']}  |  DOWN: {s['down']}  |  UNKNOWN: {s['unknown']}")
print("=" * 72)
print()

for t in data["targets"]:
    status = t["status"]
    if status == "OPERATIONAL":
        tag = "OK "
    elif status == "DEGRADED":
        tag = "DEG"
    elif status == "DOWN":
        tag = "DWN"
    else:
        tag = "???"

    lat = t.get("latency", "?")
    up = t.get("uptime", "?")
    err = t.get("error", "")
    code = t.get("httpCode", "")
    cert = t.get("certInfo") or {}
    cert_days = cert.get("daysLeft", "?")
    diag = t.get("diagnosis") or {}
    failed_at = diag.get("failedAt", "")
    diag_msg = diag.get("message", "")
    name = t["name"]
    group = t["group"]
    icon = t.get("icon", "")

    print(f"  [{tag}] {icon} {name:<25} {group:<12}  HTTP {code!s:>3}  {lat!s:>5}ms  uptime {up}%  cert {cert_days}d")
    if err:
        print(f"        error: {err}")
    if failed_at:
        print(f"        diagnosis: failed at {failed_at} - {diag_msg}")

print()

# SSL certs summary
certs = {}
for t in data["targets"]:
    ci = t.get("certInfo")
    if ci and ci.get("hostname") not in certs:
        certs[ci["hostname"]] = ci

if certs:
    print("-" * 72)
    print("  SSL Certificates:")
    print("-" * 72)
    for hostname, ci in sorted(certs.items()):
        days = ci.get("daysLeft", "?")
        issuer = ci.get("issuer", "?")
        expires = ci.get("validTo", "?")[:10]
        warn = " !! EXPIRING SOON" if isinstance(days, int) and days < 14 else ""
        print(f"    {hostname:<40} {days:>3}d left  (expires {expires})  {issuer}{warn}")
    print()
