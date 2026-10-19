#!/usr/bin/env python3
"""After upgrade-production.py reports success for --release, hot-swap the quota-guard plugin to <release>/plugin.

No daemon restart. On install or verification failure the previous plugin directory is reinstalled.
Result: .local/reports/plugin-swap.json. Shares rollout.lock with the other production scripts.
"""
import argparse, datetime, fcntl, json, os, shutil, subprocess, sys, time
from pathlib import Path

ROOT = Path('/home/qingteng/workspace/paseo-quota-guard')
PRIVATE = Path.home() / '.local/state/paseo-quota-deploy'
PASEO = Path.home() / '.paseo'
CLI, NODE = str(Path.home() / '.local/bin/paseo'), '/usr/local/bin/node'
UPGRADE_REPORT = ROOT / '.local/reports/upgrade-production.json'
REPORT = ROOT / '.local/reports/plugin-swap.json'
TERMINAL = {'success', 'deferred', 'not_switched', 'rolled_back', 'rollback_needs_attention'}
state = {}


def record(status, **extra):
    state.update(status=status, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), **extra)
    REPORT.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')


def run(args, timeout=300):
    env = {k: v for k, v in os.environ.items() if k != 'PASEO_PASSWORD'}
    try:
        r = subprocess.run([str(a) for a in args], cwd=ROOT, capture_output=True, text=True, timeout=timeout, env=env)
        return r.returncode, r.stdout
    except subprocess.TimeoutExpired:
        return None, ''


def plugin_path():
    return json.loads((PASEO / 'config.json').read_text())['plugins']['quota-guard']['path']


def probe():
    code, out = run([NODE, 'scripts/upgrade-status.mjs'], 60)
    try:
        return json.loads(out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return None


def install(path):
    run([CLI, 'plugin', 'remove', 'quota-guard', '--home', PASEO], 120)
    return run([CLI, 'plugin', 'install', path, '--home', PASEO], 400)[0] == 0


def healthy(expected):
    for _ in range(30):
        d = probe()
        if d and d.get('plugin') and d['plugin'].get('path') == expected and d['plugin'].get('status') == 'running' \
                and (d.get('status') or {}).get('mode') == 'enforce':
            return True
        time.sleep(4)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--release', required=True)
    args = parser.parse_args()
    target = str(Path(args.release).resolve() / 'plugin')
    state['plugin'] = target
    record('waiting_for_upgrade')
    deadline = time.monotonic() + 3 * 3600
    while True:
        try:
            up = json.loads(UPGRADE_REPORT.read_text())
        except (OSError, ValueError):
            up = {}
        if up.get('release') == str(Path(args.release).resolve()) and up.get('status') in TERMINAL:
            break
        if time.monotonic() > deadline:
            record('skipped', reason='升级未在期限内结束，未替换插件')
            return 1
        time.sleep(15)
    if up['status'] != 'success':
        record('skipped', reason=f'升级结果为 {up["status"]}，未替换插件')
        return 1
    lock = open(PRIVATE / 'rollout.lock', 'w')
    fcntl.flock(lock, fcntl.LOCK_EX)
    previous = plugin_path()
    backup = PRIVATE / f'backup-plugin-swap-{datetime.datetime.now().strftime("%Y%m%d-%H%M%S")}'
    backup.mkdir(mode=0o700)
    shutil.copy2(PASEO / 'config.json', backup / 'config.json')
    record('swapping', previous=previous, backup=str(backup))
    if install(target) and healthy(target):
        record('success')
        return 0
    restored = install(previous) and healthy(previous)
    record('rolled_back' if restored else 'needs_attention', reason='新插件安装或核验失败')
    return 1


if __name__ == '__main__':
    sys.exit(main())
