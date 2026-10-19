#!/usr/bin/env python3
"""One-shot authorized rollout; waits for idle, verifies and rolls back on failure.
No credentials or raw daemon responses are printed. Runs independently of Paseo.
"""
import datetime, fcntl, json, os, shutil, subprocess, sys, time
from pathlib import Path
ROOT = Path('/home/qingteng/workspace/paseo-quota-guard')
PRIVATE = Path('/home/qingteng/.local/state/paseo-quota-deploy')
PASEO = Path('/home/qingteng/.paseo')
CLI = '/home/qingteng/.local/bin/paseo'
NODE = '/usr/local/bin/node'
RELEASE = ROOT / '.local/release-settings'
REPORT = ROOT / '.local/reports/production-deployment.json'
UNITS = ['paseo-quota-daemon.service', 'paseo-quota-guard.service']
os.umask(0o077)
os.environ["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/run/user/1000/bus"
PRIVATE.mkdir(parents=True, exist_ok=True)
REPORT.parent.mkdir(parents=True, exist_ok=True)
lock = open(PRIVATE / 'rollout.lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
state = {'status': 'preparing', 'updatedAt': '', 'release': str(RELEASE), 'productionEnabled': False}
def record(status, **details):
    state.update(status=status, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), **details)
    temp = REPORT.with_suffix('.tmp'); temp.write_text(json.dumps(state, ensure_ascii=False, indent=2)+'\n'); temp.replace(REPORT)
    print(status, flush=True)
def run(args, timeout=90):
    result = subprocess.run([str(a) for a in args], cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        (PRIVATE/'last-command-error.log').write_text(result.stdout+'\n'+result.stderr)
        raise RuntimeError('Command failed: '+Path(str(args[0])).name+' '+str(args[1] if len(args)>1 else ''))
    return result.stdout

def agents():
    data = json.loads(run([CLI, 'ls', '--json', '--home', PASEO], 30))
    return data.get('agents', []) if isinstance(data, dict) else data

def check_release():
    run([NODE, ROOT/'scripts/verify-release.mjs', RELEASE])
    for name in ['src', 'plugin', 'config']:
        target = RELEASE / ('guard' if name == 'src' else name)
        for p in (ROOT/name).rglob('*'):
            if p.is_file() and 'node_modules' not in p.parts:
                q = target/p.relative_to(ROOT/name)
                if not q.exists() or p.read_bytes() != q.read_bytes():
                    raise RuntimeError('Release differs from checked source')
    for unit in UNITS + ['paseo-original-rollback.service']:
        if not (Path.home()/'.config/systemd/user'/unit).is_file(): raise RuntimeError('Unit missing')
    if not (PRIVATE/'runtime.env').is_file(): raise RuntimeError('Runtime environment missing')

check_release()
if '--preflight' in sys.argv:
    current = agents()
    print(json.dumps({'releaseVerified': True, 'agents': len(current), 'busy': sum(a.get('status') not in ['idle','error','closed'] for a in current)}))
    sys.exit(0)
if REPORT.exists() and json.loads(REPORT.read_text()).get('status') == 'success':
    raise RuntimeError('Already deployed; do not repeat rollout')
record('waiting_for_idle')
baseline = None
for attempt in range(720):
    try:
        current = agents()
    except Exception:
        time.sleep(5); continue
    if all(a.get('status') in ['idle', 'error', 'closed'] for a in current):
        time.sleep(3)
        try: check = agents()
        except Exception: continue
        if all(a.get('status') in ['idle', 'error', 'closed'] for a in check):
            baseline = {a['id'] for a in check}; break
    time.sleep(5)
if baseline is None:
    record('deferred_busy', reason='Paseo remained busy; no restart performed')
    try:run([NODE,ROOT/'scripts/deploy-notify.mjs','failure'],30)
    except Exception:pass
    sys.exit(0)
backup = PRIVATE / ('backup-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir(mode=0o700)
shutil.copy2(PASEO/'config.json', backup/'config.json')
original_id = (PASEO/'server-id').read_bytes()
original_key = (PASEO/'daemon-keypair.json').read_bytes()
stopped = False
try:
    record('stopping_original', backup=str(backup), preservedAgents=len(baseline))
    stopped = True
    run([CLI,'daemon','stop','--home',PASEO],120)
    record('backing_up')
    shutil.copy2(PASEO/'config.json', backup/'config.json')
    run(['tar','--exclude=*.sock','--exclude=*.socket','-cf',backup/'paseo-home.tar','-C',PASEO,'.'],180)
    record('starting_candidate')
    run(['systemctl','--user','start','paseo-quota-guard.service'])
    run(['systemctl','--user','start','paseo-quota-daemon.service'])
    available = False
    for _ in range(30):
        try:
            after = agents()
            if not baseline.issubset({a['id'] for a in after}): raise RuntimeError('Missing prior agents')
            available=True;break
        except Exception:time.sleep(2)
    if not available:raise RuntimeError('Candidate unavailable or prior sessions missing')
    if (PASEO/'server-id').read_bytes()!=original_id or (PASEO/'daemon-keypair.json').read_bytes()!=original_key:
        raise RuntimeError('Daemon identity changed')
    record('installing_plugin')
    run([CLI,'plugin','install',RELEASE/'plugin','--home',PASEO],180)
    record('verifying')
    verified = None
    for _ in range(12):
        try:
            verified=json.loads(run([NODE,ROOT/'scripts/verify-production.mjs','--activate'],90));break
        except Exception:time.sleep(5)
    if not verified:raise RuntimeError('Plugin or enforcement verification failed')
    run(['systemctl','--user','enable',*UNITS])
    for unit in UNITS:
        if run(['systemctl','--user','is-active',unit]).strip()!='active':raise RuntimeError('Service inactive')
    record('success',productionEnabled=True,verification=verified,backup=str(backup),autostart=True)
    try:
        push=json.loads(run([NODE,ROOT/'scripts/deploy-notify.mjs','success'],30))
        record('success',notification=push)
    except Exception:record('success',notification={'accepted':False})
except Exception as error:
    record('rolling_back',reason=str(error))
    try:
        for unit in UNITS:
            subprocess.run(['systemctl','--user','disable','--now',unit],capture_output=True,timeout=120)
        if stopped:
            shutil.copy2(backup/'config.json',PASEO/'config.json')
            run(['systemctl','--user','enable','--now','paseo-original-rollback.service'])
            restored=False
            for _ in range(30):
                try:
                    restored=baseline.issubset({a['id'] for a in agents()})
                    if restored:break
                except Exception:pass
                time.sleep(2)
            if not restored:raise RuntimeError('Original daemon restore unconfirmed')
        record('rolled_back',productionEnabled=False)
    except Exception:record('rollback_needs_attention',productionEnabled=False)
    try:run([NODE,ROOT/'scripts/deploy-notify.mjs','failure'],30)
    except Exception:pass
    sys.exit(1)
