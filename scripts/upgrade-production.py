#!/usr/bin/env python3
"""Switch production Paseo services to a verified release once every session is stably idle.

Only the release path in the two systemd units changes. The plugin, ~/.paseo/config.json,
daemon identity and guard settings are never written. On failure the units are restored and
only services this run restarted are restarted again. No credentials or raw responses are printed.
"""
import argparse, datetime, fcntl, hashlib, json, os, re, subprocess, sys, tempfile, time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path('/home/qingteng/workspace/paseo-quota-guard')
UNITS = ('paseo-quota-guard.service', 'paseo-quota-daemon.service')  # restart order
SETTINGS = ('enabled', 'notifications', 'thresholds', 'settingsRevision')
RELEASE_RE = re.compile(r'/workspace/paseo-quota-guard/\.local/([A-Za-z0-9._-]+)/')
RESIDUAL_RISKS = [
    '切换期间无法阻止新任务进入：稳定空闲确认后新开的任务可能被重启中断（会话本身保留）',
    '子代理列表为空不能证明所有 provider 后台工作已经结束',
    '会话枚举与子代理查询会使服务端加载会话',
    '空闲判定与会话基线基于目录接口，不包含 provider 不可用或无项目归属的会话',
]


@dataclass
class Cfg:
    root: Path = ROOT
    unit_dir: Path = Path.home() / '.config/systemd/user'
    paseo: Path = Path.home() / '.paseo'
    private: Path = Path.home() / '.local/state/paseo-quota-deploy'
    report: Path = ROOT / '.local/reports/upgrade-production.json'
    node: str = '/usr/local/bin/node'
    stable_seconds: float = 60
    sample_interval: float = 10
    deadline_seconds: float = 7200
    verify_seconds: float = 420  # longer than the guard's 300 s idle poll, in case reconnect fails
    reconnect_interval: float = 30
    verify_interval: float = 5
    daemon_only: bool = False


def atomic_write(path, text, mode=0o644):
    """Replace path atomically and confirm by reading back. False if either step failed."""
    try:
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + '.', suffix='.tmp')
        try:
            with os.fdopen(fd, 'w') as f:
                f.write(text); f.flush(); os.fsync(f.fileno())
            os.chmod(tmp, mode)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        return path.read_text() == text
    except OSError:
        return False


class Sys:
    def run(self, args, timeout=120):
        try:
            r = subprocess.run([str(a) for a in args], cwd=ROOT, capture_output=True, text=True, timeout=timeout)
            return r.returncode, r.stdout
        except (subprocess.TimeoutExpired, OSError):
            return None, ''

    def write(self, path, text, mode=0o644):
        return atomic_write(path, text, mode)

    def now(self):
        return time.monotonic()

    def sleep(self, seconds):
        time.sleep(seconds)


class Abort(Exception):
    def __init__(self, stage, reason):
        super().__init__(reason)
        self.stage = stage


class Upgrade:
    def __init__(self, cfg, system, target):
        self.cfg, self.sys, self.target = cfg, system, Path(target)
        self.state = {'release': str(self.target), 'residualRisks': RESIDUAL_RISKS}

    # ---------- reporting ----------
    def record(self, status, **details):
        self.state.update(status=status, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), **details)
        try:
            self.cfg.report.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.cfg.report.with_suffix('.tmp')
            tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2) + '\n')
            os.replace(tmp, self.cfg.report)
        except OSError:
            try:
                with open(self.cfg.private / 'report-write-error.log', 'a') as f:
                    f.write(f'{self.state["updatedAt"]} {status}\n')
            except OSError:
                pass

    def notify(self, kind, extra):
        code, data = self.node_json('deploy-notify.mjs', kind, extra, timeout=30)
        return data if code == 0 and isinstance(data, dict) else {'accepted': False}

    # ---------- probes ----------
    def node_json(self, script, *args, timeout=120):
        code, out = self.sys.run([self.cfg.node, self.cfg.root / 'scripts' / script, *args], timeout)
        try:
            return code, json.loads(out.strip().splitlines()[-1])
        except (ValueError, IndexError):
            return code, None

    def sessions(self):
        code, data = self.node_json('list-sessions.mjs')
        if code != 0 or not isinstance(data, dict) or type(data.get('busy')) is not int or not isinstance(data.get('agents'), list):
            return None
        for a in data['agents']:
            if not isinstance(a, dict) or not all(isinstance(a.get(k), str) for k in ('id', 'status', 'updatedAt')):
                return None
        return data

    @staticmethod
    def stable_key(data):
        return tuple(sorted((a['id'], a['status'], a['updatedAt'], a.get('runningSubagents'), a.get('subagentStatus'))
                            for a in data['agents']))

    def probe(self):
        """Collect transient and permanent problems independently, plus every value that validated."""
        result = {'transient': [], 'permanent': [], 'values': {}}
        code, data = self.node_json('upgrade-status.mjs')
        if code != 0 or not isinstance(data, dict) or data.get('transportError'):
            result['transient'].append('daemon 不可连接')
            return result
        s, p = data.get('status'), data.get('plugin')
        if data.get('statusError'):
            result['transient'].append('status RPC 不可用')
        elif isinstance(s, dict):
            number = lambda v: type(v) in (int, float)
            t = s.get('thresholds')
            checks = [
                (s.get('mode') == 'enforce', 'mode 不是 enforce'),
                (s.get('bridgeMode') in (None, 'enforce'), 'bridgeMode 不是 enforce'),
                (type(s.get('enabled')) is bool, 'enabled 非布尔'),
                (type(s.get('notifications')) is bool, 'notifications 非布尔'),
                (type(s.get('settingsRevision')) is int, 'settingsRevision 非整数'),
                (isinstance(t, dict) and all(isinstance(t.get(k), dict) and number(t[k].get('warn')) and number(t[k].get('pause'))
                                             for k in ('claude', 'codex')), 'thresholds 结构无效'),
            ]
            result['permanent'] += [reason for ok, reason in checks if not ok]
            if s.get('bridgeMode') is None:  # guard has not polled the restarted daemon yet
                result['transient'].append('执行层尚未连接')
            if not result['permanent']:
                result['values'].update({k: s[k] for k in SETTINGS})
        else:
            result['permanent'].append('status 结构无效')
        if data.get('pluginError'):
            result['transient'].append('插件列表不可用')
            return result
        if isinstance(p, dict) and isinstance(p.get('path'), str) and p['path']:
            result['values']['pluginPath'] = p['path']
        elif isinstance(p, dict):
            result['permanent'].append('插件路径无效')
        if not isinstance(p, dict) or p.get('status') != 'running':
            result['transient'].append('quota-guard 插件未运行')
        return result

    def identity(self):
        try:
            return {n: hashlib.sha256((self.cfg.paseo / n).read_bytes()).hexdigest() for n in ('server-id', 'daemon-keypair.json')}
        except OSError:
            return None

    def service_state(self, unit):
        code, out = self.sys.run(['systemctl', '--user', 'is-active', unit], 30)
        return 'query_failed' if code is None else (out.strip() or 'unknown')

    # ---------- files ----------
    def unit_path(self, unit):
        return self.cfg.unit_dir / unit

    @staticmethod
    def unit_release(text):
        names = {m.group(1) for line in text.splitlines() if line.startswith('ExecStart=') for m in RELEASE_RE.finditer(line)}
        if len(names) != 1:
            raise Abort('parse_units', 'ExecStart 中的发布路径无法唯一识别')
        return names.pop()

    def read_units(self):
        try:
            texts = {u: self.unit_path(u).read_text() for u in UNITS}
        except OSError:
            raise Abort('parse_units', '单元文件不可读')
        names = {self.unit_release(texts[u]) for u in
                 ((UNITS[1],) if self.cfg.daemon_only else UNITS)}
        if len(names) != 1:
            raise Abort('parse_units', '两个单元指向不同的发布目录')
        return texts, names.pop()

    @staticmethod
    def same_tree(a, b, ignore=()):
        def files(d):
            return {p.relative_to(d) for p in d.rglob('*') if p.is_file() and
                    'node_modules' not in p.relative_to(d).parts and str(p.relative_to(d)) not in ignore}
        if not a.is_dir() or not b.is_dir():
            return False
        try:
            fa, fb = files(a), files(b)
            return bool(fa) and fa == fb and all((a / f).read_bytes() == (b / f).read_bytes() for f in fa)
        except OSError:
            return False

    # ---------- phases ----------
    def prepare(self):
        root, t = self.cfg.root, self.target
        if t.parent != root / '.local' or not RELEASE_RE.search(f'/workspace/paseo-quota-guard/.local/{t.name}/'):
            raise Abort('release', '目标发布目录必须位于 .local/ 下')
        if self.sys.run([self.cfg.node, root / 'scripts/verify-release.mjs', t], 600)[0] != 0:
            raise Abort('verify_release', '发布包校验失败')
        # Services only: the installed plugin is left untouched and is swapped separately after success.
        pairs = [(root / 'src', t / 'guard'), (root / 'config', t / 'config'), (root / 'plugin', t / 'plugin')]
        if not all(self.same_tree(a, b) for a, b in pairs):
            raise Abort('compare', '源码与发布包不一致')
        texts, old = self.read_units()
        if self.cfg.daemon_only:
            guard_release = root / '.local' / self.unit_release(texts[UNITS[0]])
            if not self.same_tree(guard_release / 'guard', t / 'guard',
                                  ignore=('bridge.mjs', 'claude-task-stop.mjs')):
                raise Abort('compare', 'daemon-only 不允许遗漏 guard 服务代码变更')
            self.unchanged_guard_unit = texts[UNITS[0]]
        if old == t.name:
            raise Abort('parse_units', '服务已指向目标发布目录')
        m = re.search(r'^Environment=QUOTA_GUARD_CONFIG=(\S+)$', texts[UNITS[0]], re.M)
        if not m:
            raise Abort('guard_config', 'guard 单元未声明 QUOTA_GUARD_CONFIG')
        guard_config = m.group(1).replace('%h', str(Path.home()))
        if self.sys.run([self.cfg.node, root / 'scripts/check-guard-config.mjs', t, guard_config], 60)[0] != 0:
            raise Abort('guard_config', '新版 guard 无法通过生产配置校验，未切换')
        if not (root / '.local' / old).is_dir():
            raise Abort('parse_units', '当前发布目录不存在')
        return texts, old

    def wait_stable(self, deadline):
        key = since = None
        while self.sys.now() < deadline:
            data = self.sessions()
            now = self.sys.now()
            if now >= deadline:
                break
            if data is None or data['busy'] != 0:
                key = since = None
            elif self.stable_key(data) != key:
                key, since = self.stable_key(data), now
            elif now - since >= self.cfg.stable_seconds:
                return data
            self.sys.sleep(self.cfg.sample_interval)
        return None

    def snapshot(self):
        for _ in range(5):
            r = self.probe()
            if r['permanent']:
                raise Abort('snapshot', '；'.join(r['permanent']))
            if not r['transient'] and set(SETTINGS) | {'pluginPath'} <= r['values'].keys():
                return r['values']
            self.sys.sleep(self.cfg.verify_interval)
        raise Abort('snapshot', '无法读取切换前状态')

    def reconnect(self):
        self.last_reconnect = self.sys.now()
        self.node_json('guard-reconnect.mjs', timeout=100)

    def verify(self, release, snapshot, baseline, ident):
        end = self.sys.now() + self.cfg.verify_seconds
        while True:
            transient, permanent = [], []
            try:
                if self.read_units()[1] != release:
                    permanent.append('单元未指向预期发布目录')
                if self.cfg.daemon_only and self.read_units()[0][UNITS[0]] != self.unchanged_guard_unit:
                    permanent.append('未参与切换的 guard 单元已改变')
            except Abort:
                permanent.append('单元文件不可读或无法解析')
            if self.identity() != ident:
                permanent.append('daemon 身份文件已改变或不可读')
            transient += [f'{u} 未运行' for u in UNITS if self.service_state(u) != 'active']
            r = self.probe()
            transient += r['transient']
            permanent += r['permanent']
            if '执行层尚未连接' in r['transient'] and self.sys.now() - getattr(self, 'last_reconnect', -1e9) >= self.cfg.reconnect_interval:
                self.reconnect()
            permanent += [f'{k} 已改变' for k, v in r['values'].items() if v != snapshot[k] or type(v) is not type(snapshot[k])]
            current = self.sessions()
            if current is None or not baseline <= {a['id'] for a in current['agents']}:
                transient.append('会话基线尚未恢复')
            if permanent:
                return 'permanent', permanent
            if not transient:
                return 'ok', []
            if self.sys.now() >= end:
                return 'timeout', transient
            self.sys.sleep(self.cfg.verify_interval)

    def switch(self, texts, old, progress):
        units = (UNITS[1],) if self.cfg.daemon_only else UNITS
        for u in units:
            progress['touched'].append(u)  # before writing: a failed read-back may follow a completed replace
            if not self.sys.write(self.unit_path(u), texts[u].replace(f'/.local/{old}/', f'/.local/{self.target.name}/')):
                raise Abort('write_units', f'{u} 写入失败')
        if self.sys.run(['systemctl', '--user', 'daemon-reload'])[0] != 0:
            raise Abort('daemon_reload', 'daemon-reload 失败')
        for u in units:
            progress['restarted'].append(u)
            if self.sys.run(['systemctl', '--user', 'restart', u], 180)[0] != 0:
                raise Abort('restart', f'{u} 重启失败')

    def stalled(self, stage, problems):
        states = {u: self.service_state(u) for u in UNITS}
        if states[UNITS[1]] != 'active':
            problems.append('daemon 当前未运行，可能没有可用的 Paseo，需要人工处理')
        return 'rollback_needs_attention', {'rollbackStage': stage, 'unconfirmed': problems, 'serviceStates': states}

    def rollback(self, texts, old, progress, snapshot, baseline, ident):
        failed = [u for u in progress['touched'] if not self.sys.write(self.unit_path(u), texts[u])]
        if failed:
            return self.stalled('restore_units', [f'{u} 未能恢复，未重启任何服务' for u in failed])
        if progress['touched'] and self.sys.run(['systemctl', '--user', 'daemon-reload'])[0] != 0:
            return self.stalled('daemon_reload', ['daemon-reload 失败，未重启任何服务'])
        unconfirmed = [f'{u} 回滚重启失败' for u in UNITS
                       if u in progress['restarted'] and self.sys.run(['systemctl', '--user', 'restart', u], 180)[0] != 0]
        kind, problems = self.verify(old, snapshot, baseline, ident)
        if kind == 'ok' and not unconfirmed:
            return 'rolled_back', {'rollbackStage': 'verified'}
        return self.stalled('verify', unconfirmed + problems)

    def backup(self, texts):
        directory = self.cfg.private / f'backup-upgrade-{datetime.datetime.now().strftime("%Y%m%d-%H%M%S")}'
        try:
            directory.mkdir(mode=0o700)
        except OSError:
            raise Abort('backup', '无法创建备份目录')
        if not all(self.sys.write(directory / u, texts[u], 0o600) for u in UNITS):
            raise Abort('backup', '单元备份失败')
        return directory

    def defer(self):
        self.record('deferred', reason='在期限内无法确认全部会话稳定空闲，未切换服务')
        self.notify('upgrade-failure', 'deferred')
        return 1

    def execute(self):
        self.record('preparing')
        try:
            texts, old = self.prepare()
            self.state['previousRelease'] = str(self.cfg.root / '.local' / old)
            deadline = self.sys.now() + self.cfg.deadline_seconds
            while True:
                self.record('waiting_for_idle')
                stable = self.wait_stable(deadline)
                if stable is None:
                    return self.defer()
                snapshot, ident = self.snapshot(), self.identity()
                if ident is None:
                    raise Abort('snapshot', '无法读取 daemon 身份文件')
                if self.read_units()[0] != texts:
                    raise Abort('parse_units', '等待期间单元文件被修改')
                final = self.sessions()
                if final and final['busy'] == 0 and self.stable_key(final) == self.stable_key(stable):
                    break
            backup = self.backup(texts)
        except Abort as e:
            self.record('not_switched', stage=e.stage, reason=str(e))
            self.notify('upgrade-failure', 'not_switched')
            return 1
        baseline = {a['id'] for a in stable['agents']}
        progress = {'touched': [], 'restarted': []}
        self.record('switching', backup=str(backup), snapshot={k: snapshot[k] for k in ('enabled', 'notifications', 'settingsRevision')})
        if self.sys.now() >= deadline:  # last check, immediately before the first unit is modified
            return self.defer()
        try:
            self.switch(texts, old, progress)
            kind, problems = self.verify(self.target.name, snapshot, baseline, ident)
            if kind != 'ok':
                raise Abort('verify', '；'.join(problems))
        except Abort as e:
            self.record('rolling_back', stage=e.stage, reason=str(e), switchProgress=progress)
            status, details = self.rollback(texts, old, progress, snapshot, baseline, ident)
            self.record(status, **details)
            self.notify('upgrade-failure', status)
            return 1
        self.record('success', switchProgress=progress)
        self.record('success', notification=self.notify('upgrade-success', 'true' if snapshot['enabled'] else 'false'))
        return 0


def preflight(cfg, target):
    """Strictly read-only: compares trees and parses units; no RPC, no verify-release, no writes."""
    up = Upgrade(cfg, None, target)
    try:
        root, t = cfg.root, Path(target)
        trees = all(up.same_tree(a, b) for a, b in [(root / 'src', t / 'guard'), (root / 'config', t / 'config'),
                                                     (root / 'plugin', t / 'plugin')])
        _, old = up.read_units()
        return {'treesMatch': trees, 'currentRelease': old, 'targetRelease': t.name, 'alreadyTarget': old == t.name}
    except (Abort, OSError, ValueError, KeyError, TypeError) as e:
        return {'error': type(e).__name__}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--release')
    parser.add_argument('--preflight', action='store_true')
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--daemon-only', action='store_true',
                        help='仅切换 daemon 中的 bridge；要求 guard 其余源码完全一致')
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    if not args.release:
        parser.error('--release is required')
    cfg, target = Cfg(daemon_only=args.daemon_only), Path(args.release).resolve()
    if args.preflight:
        print(json.dumps(preflight(cfg, target), ensure_ascii=False))
        return 0
    os.umask(0o077)
    os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/run/user/1000/bus'
    up = Upgrade(cfg, Sys(), target)
    try:
        cfg.private.mkdir(parents=True, exist_ok=True)
        lock = open(cfg.private / 'rollout.lock', 'w')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        up.record('not_switched', stage='lock', reason='无法获取生产变更锁')
        return 1
    return up.execute()


# ---------------------------------------------------------------- self-test
def short(unit):
    return unit.split('.')[0].rsplit('-', 1)[-1]


class FakeSys:
    """In-memory systemd/daemon double. `ops` records every mutating action in order."""

    def __init__(self, scenario, unit_dir):
        self.s, self.unit_dir, self.clock = scenario, unit_dir, 0.0
        self.ops, self.unit_writes = [], {}
        self.states = {u: 'active' for u in UNITS}
        self.status = {'mode': 'enforce', 'bridgeMode': 'enforce', 'enabled': False, 'notifications': False,
                       'thresholds': {'claude': {'warn': 80, 'pause': 90}, 'codex': {'warn': 90, 'pause': 95}}, 'settingsRevision': 4}
        self.restarts, self.reconnects, self.restarted_at = 0, 0, None

    def now(self):
        return self.clock

    def sleep(self, seconds):
        self.clock += seconds

    def write(self, path, text, mode=0o644):
        if path.parent != self.unit_dir:
            self.ops.append(f'backup {short(path.name)}')
            self.clock += self.s.get('backup_cost', 0)
            return atomic_write(path, text, mode)
        n = self.unit_writes[path.name] = self.unit_writes.get(path.name, 0) + 1
        self.ops.append(f'write {short(path.name)}')
        fault = self.s.get('write_faults', {}).get((path.name, n))
        if fault == 'before':
            return False
        ok = atomic_write(path, text, mode)
        return False if fault == 'after' else ok

    def run(self, args, timeout=120):
        args = [str(a) for a in args]
        self.clock += 1
        if args[0] == '/fake/node':
            name = Path(args[1]).name
            if name in ('verify-release.mjs', 'deploy-notify.mjs'):
                return 0, '{"accepted": true}'
            if name == 'check-guard-config.mjs':
                return (1, '{"ok": false}') if self.s.get('config_invalid') else (0, '{"ok": true}')
            if name == 'list-sessions.mjs':
                busy = 1 if self.s.get('always_busy') else 0
                return 0, json.dumps({'total': 1, 'busy': busy, 'agents': [{'id': 'a1', 'status': 'idle', 'updatedAt': 't0'}]})
            if name == 'guard-reconnect.mjs':
                self.reconnects += 1
                if not self.s.get('reconnect_fails') and self.states[UNITS[0]] == 'active':
                    self.status['bridgeMode'] = 'enforce'
                return 0, '{"ok": true}'
            if name == 'upgrade-status.mjs':
                if self.restarted_at is not None and self.clock - self.restarted_at >= self.s.get('poll_seconds', 300):
                    self.status['bridgeMode'] = 'enforce'  # the guard's own idle poll
                if self.states[UNITS[1]] != 'active':
                    return 2, '{"transportError": true}'
                payload = {'status': dict(self.status), 'plugin': {'path': '/p', 'status': 'running'}}
                if self.s.get('status_hook'):
                    payload = self.s['status_hook'](self, payload)
                return 0, json.dumps(payload)
        verb, unit = args[2], args[3] if len(args) > 3 else None
        if verb == 'is-active':
            return (0 if self.states[unit] == 'active' else 3), self.states[unit] + '\n'
        self.ops.append(f'{verb} {short(unit)}' if unit else verb)
        if verb == 'daemon-reload':
            results = self.s.setdefault('reload_results', [])
            return (results.pop(0) if results else 0), ''
        if verb == 'restart':
            self.restarts += 1
            self.status['bridgeMode'], self.restarted_at = None, self.clock
            fails = self.s.get('restart_fail', {})
            if fails.get(unit):
                fails[unit] -= 1
                self.states[unit] = 'failed'
                return 1, ''
            stuck = self.s.get('stuck', {})
            self.states[unit] = 'activating' if stuck.get(unit) else 'active'
            if stuck.get(unit):
                stuck[unit] -= 1
            return 0, ''
        raise AssertionError('unexpected command ' + ' '.join(args))


class Timed(Upgrade):
    """Lets a scenario charge simulated time for writing the 'switching' report."""

    def record(self, status, **details):
        if status == 'switching':
            self.sys.clock += self.sys.s.get('switching_record_cost', 0)
        super().record(status, **details)


def self_test():
    import shutil
    G, D = short(UNITS[0]), short(UNITS[1])
    BACKUP = [f'backup {G}', f'backup {D}']
    SWITCH = [f'write {G}', f'write {D}', 'daemon-reload', f'restart {G}', f'restart {D}']

    def setup(tmp):
        root = tmp / 'root'
        for d in ('src', 'config', 'plugin'):
            (root / d).mkdir(parents=True); (root / d / 'f.txt').write_text(d)
        for rel in ('rel-old', 'rel-new'):
            for src, dst in (('src', 'guard'), ('config', 'config'), ('plugin', 'plugin')):
                shutil.copytree(root / src, root / '.local' / rel / dst)
        units = tmp / 'units'; units.mkdir()
        for u, tail in zip(UNITS, ('guard/main.mjs', 'server/dist/x.js')):
            (units / u).write_text(f'[Service]\nExecStart=/usr/local/bin/node %h/workspace/paseo-quota-guard/.local/rel-old/{tail}\n'
                                  'Environment=QUOTA_GUARD_CONFIG=%h/.config/paseo-quota-guard/config.json\nRestart=on-failure\n')
        paseo = tmp / 'paseo'; paseo.mkdir()
        (paseo / 'server-id').write_text('srv'); (paseo / 'daemon-keypair.json').write_text('{}')
        (paseo / 'config.json').write_text(json.dumps({'plugins': {'quota-guard': {'path': str(root / '.local/rel-old/plugin')}}}))
        private = tmp / 'private'; private.mkdir()
        return Cfg(root=root, unit_dir=units, paseo=paseo, private=private, report=tmp / 'report.json', node='/fake/node',
                   deadline_seconds=600, verify_seconds=30)

    def case(scenario, check):
        with tempfile.TemporaryDirectory() as d:
            cfg = setup(Path(d))
            fake = FakeSys(scenario, cfg.unit_dir)
            code = Timed(cfg, fake, cfg.root / '.local/rel-new').execute()
            report = json.loads(cfg.report.read_text())
            units = [(cfg.unit_dir / u).read_text() for u in UNITS]
            on = lambda rel: all(f'/.local/{rel}/' in t for t in units)
            check(code, report, on, fake.ops, fake)

    def ok(code, r, on, ops, f):
        assert code == 0 and r['status'] == 'success' and on('rel-new'), r
        assert ops == BACKUP + SWITCH and f.clock >= 60 and f.reconnects >= 1, (ops, f.reconnects)
    case({}, ok)

    # Bridge-only deployments may start with guard and daemon on different releases.
    # Preserve the guard unit and process on both success and rollback.
    for fails in (False, True):
        with tempfile.TemporaryDirectory() as d:
            cfg = setup(Path(d)); cfg.daemon_only = True
            guard_unit = cfg.unit_dir / UNITS[0]
            guard_unit.write_text(guard_unit.read_text().replace('/rel-old/', '/rel-new/'))
            before = guard_unit.read_bytes()
            scenario = {'restart_fail': {UNITS[1]: 1}} if fails else {}
            fake = FakeSys(scenario, cfg.unit_dir)
            code = Timed(cfg, fake, cfg.root / '.local/rel-new').execute()
            r = json.loads(cfg.report.read_text())
            assert r['status'] == ('rolled_back' if fails else 'success'), r
            assert guard_unit.read_bytes() == before
            assert f'write {G}' not in fake.ops and f'restart {G}' not in fake.ops, fake.ops
            expected = 'rel-old' if fails else 'rel-new'
            assert f'/.local/{expected}/' in (cfg.unit_dir / UNITS[1]).read_text()
            assert code == (1 if fails else 0)

    with tempfile.TemporaryDirectory() as d:
        cfg = setup(Path(d)); cfg.daemon_only = True
        (cfg.root / '.local/rel-old/guard/f.txt').write_text('old guard code')
        fake = FakeSys({}, cfg.unit_dir)
        assert Timed(cfg, fake, cfg.root / '.local/rel-new').execute() == 1
        assert json.loads(cfg.report.read_text())['stage'] == 'compare'
        assert fake.ops == [], 'guard 代码存在其他差异时不得切换'

    def own_poll_connects(code, r, on, ops, f):
        assert r['status'] == 'success' and on('rel-new') and ops == BACKUP + SWITCH, (r, ops)
    case({'reconnect_fails': True, 'poll_seconds': 20}, own_poll_connects)

    def never_connects(code, r, on, ops, f):
        assert r['status'] == 'rollback_needs_attention' and on('rel-old'), r
        assert '执行层尚未连接' in r['reason'] and any('执行层尚未连接' in u for u in r['unconfirmed']), r
        assert ops == BACKUP + SWITCH + [f'write {G}', f'write {D}', 'daemon-reload', f'restart {G}', f'restart {D}'], ops
        assert 2 <= f.reconnects <= 4, f.reconnects  # throttled to one per reconnect_interval
    case({'reconnect_fails': True, 'poll_seconds': 10 ** 6}, never_connects)

    def wrong_bridge_mode(f, payload):
        if f.restarts and payload['status']['bridgeMode'] == 'enforce':
            payload['status']['bridgeMode'] = 'observe'
        return payload

    def bridge_mode_mismatch(code, r, on, ops, f):
        assert r['status'] == 'rollback_needs_attention' and on('rel-old') and 'bridgeMode 不是 enforce' in r['reason'], r
    case({'status_hook': wrong_bridge_mode}, bridge_mode_mismatch)

    def first_write_fails(code, r, on, ops, f):
        assert r['status'] == 'rolled_back' and on('rel-old'), r
        assert ops == BACKUP + [f'write {G}', f'write {G}', 'daemon-reload'], ops
    case({'write_faults': {(UNITS[0], 1): 'before'}}, first_write_fails)

    def readback_fails_after_replace(code, r, on, ops, f):
        assert r['status'] == 'rolled_back' and on('rel-old') and r['switchProgress']['touched'] == list(UNITS), r
        assert ops == BACKUP + [f'write {G}', f'write {D}', f'write {G}', f'write {D}', 'daemon-reload'], ops
    case({'write_faults': {(UNITS[1], 1): 'after'}}, readback_fails_after_replace)

    def reload_fails(code, r, on, ops, f):
        assert r['status'] == 'rolled_back' and on('rel-old') and f.restarts == 0, r
        assert ops == BACKUP + SWITCH[:3] + [f'write {G}', f'write {D}', 'daemon-reload'], ops
    case({'reload_results': [1, 0]}, reload_fails)

    def guard_restart_fails(code, r, on, ops, f):
        assert r['status'] == 'rolled_back' and on('rel-old'), r
        assert ops == BACKUP + SWITCH[:4] + [f'write {G}', f'write {D}', 'daemon-reload', f'restart {G}'], ops
    case({'restart_fail': {UNITS[0]: 1}}, guard_restart_fails)

    def daemon_restart_fails(code, r, on, ops, f):
        assert r['status'] == 'rolled_back' and on('rel-old'), r
        assert ops == BACKUP + SWITCH + [f'write {G}', f'write {D}', 'daemon-reload', f'restart {G}', f'restart {D}'], ops
    case({'restart_fail': {UNITS[1]: 1}}, daemon_restart_fails)

    def restore_fails(code, r, on, ops, f):
        assert r['status'] == 'rollback_needs_attention' and r['rollbackStage'] == 'restore_units', r
        assert r['serviceStates'][UNITS[1]] == 'failed' and any('没有可用' in u for u in r['unconfirmed']), r
        assert ops == BACKUP + SWITCH + [f'write {G}', f'write {D}'], ops
    case({'restart_fail': {UNITS[1]: 1}, 'write_faults': {(UNITS[1], 2): 'before'}}, restore_fails)

    def restore_reload_fails(code, r, on, ops, f):
        assert r['status'] == 'rollback_needs_attention' and r['rollbackStage'] == 'daemon_reload' and on('rel-old'), r
        assert ops == BACKUP + SWITCH + [f'write {G}', f'write {D}', 'daemon-reload'], ops
    case({'restart_fail': {UNITS[1]: 1}, 'reload_results': [0, 1]}, restore_reload_fails)

    def verify_timeout(code, r, on, ops, f):
        assert r['status'] == 'rolled_back' and on('rel-old') and r['stage'] == 'verify', r
        assert ops == BACKUP + SWITCH + [f'write {G}', f'write {D}', 'daemon-reload', f'restart {G}', f'restart {D}'], ops
    case({'stuck': {UNITS[1]: 1}}, verify_timeout)

    def permanent_not_masked(code, r, on, ops, f):
        assert r['status'] == 'rollback_needs_attention' and on('rel-old'), r
        assert r['stage'] == 'verify' and 'notifications' in r['reason'], r
        assert ops == BACKUP + SWITCH + [f'write {G}', f'write {D}', 'daemon-reload', f'restart {G}', f'restart {D}'], ops

    def plugin_stopped(f, payload):
        if f.restarts:
            payload['status']['notifications'], payload['plugin']['status'] = 1, 'stopped'
        return payload
    case({'status_hook': plugin_stopped}, permanent_not_masked)

    def plugin_list_failed(f, payload):
        if f.restarts:
            payload.update(pluginError=True, plugin=None)
            payload['status']['notifications'] = 1
        return payload
    case({'status_hook': plugin_list_failed}, permanent_not_masked)

    def busy(code, r, on, ops, f):
        assert r['status'] == 'deferred' and on('rel-old') and ops == [], (r, ops)
    case({'always_busy': True}, busy)

    def past_deadline(code, r, on, ops, f):
        assert r['status'] == 'deferred' and on('rel-old') and ops == BACKUP, (r, ops)
    case({'backup_cost': 300}, past_deadline)
    case({'switching_record_cost': 600}, past_deadline)

    def config_invalid(code, r, on, ops, f):
        assert r['status'] == 'not_switched' and r['stage'] == 'guard_config' and on('rel-old') and ops == [], (r, ops)
    case({'config_invalid': True}, config_invalid)

    def missing_field(code, r, on, ops, f):
        assert r['status'] == 'not_switched' and r['stage'] == 'snapshot' and ops == [], (r, ops)
    case({'status_hook': lambda f, p: p | {'status': {k: v for k, v in p['status'].items() if k != 'notifications'}}}, missing_field)

    with tempfile.TemporaryDirectory() as d:
        cfg = setup(Path(d)); cfg.report = Path(d) / 'missing' / 'x' / 'report.json'
        (Path(d) / 'missing').write_text('not a directory')
        Upgrade(cfg, FakeSys({}, cfg.unit_dir), cfg.root / '.local/rel-new').record('preparing')
        assert (cfg.private / 'report-write-error.log').exists()
        assert preflight(cfg, cfg.root / '.local/rel-new') == {'treesMatch': True, 'currentRelease': 'rel-old',
                                                              'targetRelease': 'rel-new', 'alreadyTarget': False}
    print('self-test OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
