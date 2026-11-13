"""
Phase 4B-1R.6 — Python Sidecar Containment Tests

Tests that mouse_keyboard.py rejects actuation commands at the Python entry
point (direct CLI invocation), regardless of the TypeScript layer.

Run with: python tests/containment/phase4b-python-sidecar.test.py
"""

import json
import subprocess
import sys
import os

script = os.path.join(os.path.dirname(__file__), "..", "..", "lib", "agent", "tools", "desktop", "python", "mouse_keyboard.py")
script = os.path.normpath(script)

passed = 0
failed = 0

def run_cmd(command, args):
    result = subprocess.run(
        [sys.executable, "-I", script, command, json.dumps(args)],
        capture_output=True, text=True, timeout=10
    )
    try:
        return json.loads(result.stdout.strip())
    except Exception:
        return {"success": False, "error": f"bad stdout: {result.stdout!r} stderr: {result.stderr!r}"}

def check(condition, label):
    global passed, failed
    if condition:
        print(f"  PASS: {label}")
        passed += 1
    else:
        print(f"  FAIL: {label}")
        failed += 1

print("\n[Suite 1] Actuation commands blocked at Python CLI layer")

BLOCKED = [
    ("mouse_move",   {"x": 0, "y": 0}),
    ("mouse_click",  {"button": "left", "clicks": 1}),
    ("mouse_scroll", {"amount": 5}),
    ("type_text",    {"text": "hello"}),
    ("press_key",    {"key": "enter"}),
    ("hotkey",       {"keys": ["ctrl", "c"]}),
]

for cmd, args in BLOCKED:
    res = run_cmd(cmd, args)
    check(res.get("success") is False, f"{cmd} success=False")
    check("4B-1R.6" in (res.get("error") or ""), f"{cmd} error contains 4B-1R.6")

print("\n[Suite 2] Read-only commands pass through (size, position, take_screenshot)")

READ_ONLY = [
    ("size",     {}),
    ("position", {}),
]

for cmd, args in READ_ONLY:
    res = run_cmd(cmd, args)
    is_containment_block = "4B-1R.6" in (res.get("error") or "")
    check(not is_containment_block, f"{cmd} is NOT blocked by containment")

# take_screenshot may fail if no display — that's fine; must NOT be a containment block
res = run_cmd("take_screenshot", {})
is_containment_block = "4B-1R.6" in (res.get("error") or "")
check(not is_containment_block, "take_screenshot is NOT blocked by containment")

print("\n" + "-"*60)
print(f"Phase 4B-1R.6 Python Sidecar Tests: {passed} passed, {failed} failed")
if failed:
    print("SOME TESTS FAILED")
    sys.exit(1)
else:
    print("ALL TESTS PASSED")
