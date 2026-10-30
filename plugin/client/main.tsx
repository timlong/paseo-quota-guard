import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { View, Text, Pressable, Switch, StyleSheet, Image } from 'react-native';
import { useRpc, type PluginScreenProps, type PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { Icon, ScrollView, TextInput } from '@getpaseo/plugin/client/react-native';
import { control, type Account, type CodexCredits, type Snapshot } from '../shared/rpc';
import { PROVIDER_ICONS, QUOTA_MARK } from './provider-icons';

type Colors = PluginScreenProps['theme']['colors'];
type Threshold = { warn: number; pause: number };
const thresholdFor = (data: Snapshot, provider: string, window: string): Threshold | undefined =>
  data.thresholds[provider]?.windows?.[window as 'five_hour' | 'weekly'] ?? data.thresholds[provider];
const THRESHOLD_ROWS = [
  { key: 'claudeFiveHour', provider: 'claude', window: 'five_hour', label: 'Claude · 5 小时' },
  { key: 'claudeWeekly', provider: 'claude', window: 'weekly', label: 'Claude · 周' },
  { key: 'codex', provider: 'codex', window: 'weekly', label: 'Codex' },
] as const;

function formatReset(reset: string | null): string {
  const ms = reset ? Date.parse(reset) - Date.now() : NaN;
  if (Number.isNaN(ms)) return '重置时间未知';
  if (ms <= 0) return '即将重置';
  if (ms < 3600000) return `${Math.max(1, Math.floor(ms / 60000))} 分钟后重置`;
  if (ms < 172800000) return `${Math.floor(ms / 3600000)} 小时后重置`;
  return `${Math.floor(ms / 86400000)} 天后重置`;
}

/** Fixed GMT+8 regardless of device time zone, e.g. "10/23, 04:57". */
function gmt8(ms: number): string {
  const d = new Date(ms + 8 * 3600000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function until(ms: number): string {
  const hours = (ms - Date.now()) / 3600000;
  if (hours <= 0) return '已过期';
  return hours < 24 ? `${Math.max(1, Math.floor(hours))}小时后` : `${Math.floor(hours / 24)}天后`;
}

const RESET_OUTCOMES: Record<string, string> = {
  reset: 'Codex 额度已重置。新读数满足恢复条件后，将自动解除额度保护暂停；手动暂停保持不变。',
  nothingToReset: 'Codex 后端表示当前没有需要重置的额度。',
  noCredit: '没有可用的重置卡。',
  alreadyRedeemed: '该重置卡已被使用。',
  rejected: 'Codex 接口拒绝了此次 Reset，请刷新后核对卡片状态。',
  unknown: 'Reset 结果待确认，已尝试刷新卡片和额度。请核对后再决定是否重试这张卡。',
};

function formatAgo(fetchedAt: number | null): string {
  const date = new Date(fetchedAt ?? NaN);
  if (Number.isNaN(date.getTime())) return '无有效数据';
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return date.toLocaleString();
}

function protectionStatus(data: Snapshot | null, c: Colors) {
  if (!data) return { tag: '连接中', color: c.foregroundMuted, line: '正在连接额度保护服务…' };
  if (!data.enabled) return { tag: '已关闭', color: c.foregroundMuted, line: '保护已关闭：仅显示用量，不预警、不暂停、不拦截新请求' };
  if (data.mode !== 'enforce') return { tag: '观察模式', color: c.accent, line: '保护开关已开启；当前为观察部署，不会执行暂停' };
  return data.enforcementReady
    ? { tag: '保护中', color: c.statusSuccess, line: '额度保护已开启' }
    : { tag: '执行层未就绪', color: c.statusWarning, line: '保护开关已开启，但执行层未就绪' };
}

function accountBadge(data: Snapshot, a: Account, c: Colors) {
  if (!data.enabled) return { text: '未启用', color: c.foregroundMuted };
  if (a.locked) {
    if (data.mode === 'observe') return { text: '模拟暂停', color: c.statusWarning };
    if (a.stopStatus === 'paused') return { text: '已暂停', color: c.statusDanger };
    return { text: a.stopStatus === 'partial' ? '暂停未完成' : '正在暂停', color: c.statusWarning };
  }
  if (a.assessment.level === 'unknown') return { text: '额度未知', color: c.foregroundMuted };
  if (a.assessment.level === 'warning') return { text: '预警', color: c.statusWarning };
  return { text: '正常', color: c.statusSuccess };
}

export function Sidebar(props: PluginSidebarItemProps) {
  const rpc = useRpc(control);
  const [data, setData] = useState<Snapshot | null>(null);
  useEffect(() => {
    // Reads the guard's in-memory snapshot only; upstream usage is fetched by the guard on its own schedule.
    let alive = true;
    const load = () => rpc({ action: 'status' }).then(d => { if (alive) setData(d as unknown as Snapshot); }).catch(() => {});
    void load();
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [rpc]);
  const c = props.theme.colors;
  // Red only when every account is paused; a single paused provider is already flagged by its own red icon.
  const allPaused = !!data?.accounts.length && data.accounts.every(a => a.locked);
  const state = !data || !data.enabled ? c.foregroundMuted : allPaused ? c.statusDanger
    : data.enforcementReady ? c.statusSuccess : c.statusWarning;
  const label = data?.accounts.length ? `额度保护：${usageText(data)}` : '额度保护';
  // Custom row with the host SidebarRow metrics (28 min height, 4/8 padding, 8 gap, 14px icon, radius 8):
  // the host row reserves a flexible text slot, which would push the usage to the far right.
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => props.openScreen({ screenId: 'dashboard' })}
    style={state => [styles.sidebarRow, ((state as { hovered?: boolean }).hovered || state.pressed || props.currentScreen) && { backgroundColor: c.surface2 }]}>
    <Image source={{ uri: QUOTA_MARK }} accessibilityIgnoresInvertColors style={{ width: 14, height: 14, tintColor: state }} />
    {data?.accounts.length ? <UsageInline c={c} data={data} /> : <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>额度保护</Text>}
  </Pressable>;
}

function usageText(data: Snapshot) {
  return data.accounts.map(a => `${a.provider === 'claude' ? 'Claude' : 'Codex'} ${sortWindows(a).map(w => `${w.id === 'weekly' ? '周' : '5 小时'} ${w.used}%`).join('，') || '无数据'}`).join('；');
}

const WINDOW_ORDER = ['five_hour', 'weekly'];
const sortWindows = (a: Account) => [...a.windows].sort((x, y) => WINDOW_ORDER.indexOf(x.id) - WINDOW_ORDER.indexOf(y.id));

/** The same Claude / OpenAI marks as Paseo's own usage bar, tinted to the theme. */
function ProviderIcon({ provider, size, color }: { provider: string; size: number; color: string }) {
  const uri = PROVIDER_ICONS[provider];
  return uri ? <Image source={{ uri }} accessibilityIgnoresInvertColors style={{ width: size, height: size, tintColor: color }} />
    : <Icon name="Gauge" size={size} color={color} />;
}

/** One line: "✳ 8% 5h 35% wk  ⊛ 7% wk" — every window labelled, each number tinted by its threshold. */
function UsageInline({ c, data }: { c: Colors; data: Snapshot }) {
  const tone = (a: Account, used: number, window: string) => {
    const t = thresholdFor(data, a.provider, window);
    if (a.assessment.level === 'unknown') return c.foregroundMuted;
    if (!data.enabled || !t) return c.foreground;
    return used >= t.pause ? c.statusDanger : used >= t.warn ? c.statusWarning : c.foreground;
  };
  return <View style={[styles.row, { gap: 10, flexShrink: 1 }]}>
    {data.accounts.map(a => <View key={a.id} style={[styles.row, { gap: 4 }]}>
      <ProviderIcon provider={a.provider} size={13} color={a.locked ? c.statusDanger : c.foregroundMuted} />
      <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] }}>
        {a.windows.length ? sortWindows(a).map((w, i) => <Text key={w.id} style={{ color: tone(a, w.used, w.id) }}>
          {i > 0 ? ' ' : ''}{w.used}%<Text style={{ color: c.foregroundMuted, fontWeight: '400', fontSize: 11 }}>{'\u2009'}{w.id === 'weekly' ? 'wk' : '5h'}</Text>
        </Text>) : <Text style={{ color: c.foregroundMuted }}>—</Text>}
      </Text>
    </View>)}
  </View>;
}

export function Dashboard({ theme, layout }: PluginScreenProps) {
  const c = theme.colors;
  const rpc = useRpc(control);
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState({ claudeFiveHour: { warn: '80', pause: '90' }, claudeWeekly: { warn: '80', pause: '90' }, codex: { warn: '90', pause: '95' } });
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [creditErrors, setCreditErrors] = useState<Record<string, string>>({});
  const creditsRequested = useRef(new Set<string>());
  const resetInFlight = useRef(false);
  const resetRequests = useRef(new Map<string, string>());
  const load = useCallback(async () => {
    try { setData(await rpc({ action: 'status' }) as unknown as Snapshot); setError(''); }
    catch (e) { setError(String(e)); }
  }, [rpc]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    if (data && editingRevision === null) {
      const values = Object.fromEntries(THRESHOLD_ROWS.map(row => {
        const t = thresholdFor(data, row.provider, row.window)!;
        return [row.key, { warn: String(t.warn), pause: String(t.pause) }];
      })) as typeof draft;
      setDraft(values);
    }
  }, [data, editingRevision]);
  async function save(options: { enabled?: boolean; notifications?: boolean; thresholds?: boolean } = {}) {
    if (!data) return;
    setBusy(true); setNotice(''); setError('');
    try {
      const parsed = options.thresholds ? Object.fromEntries(Object.entries(draft).map(([p, t]) => {
        if (!t.warn.trim() || !t.pause.trim()) throw new Error('请填写预警和暂停百分比');
        const warn = Number(t.warn), pause = Number(t.pause);
        if (!Number.isFinite(warn) || !Number.isFinite(pause) || warn < 0 || warn >= pause || pause > 100)
          throw new Error('阈值需满足：0 ≤ 预警 < 自动暂停 ≤ 100');
        return [p, { warn, pause }];
      })) : null;
      const thresholds = parsed ? {
        claude: { warn: data.thresholds.claude.warn, pause: data.thresholds.claude.pause,
          windows: { five_hour: parsed.claudeFiveHour, weekly: parsed.claudeWeekly } },
        codex: parsed.codex,
      } : data.thresholds;
      await rpc({ action: 'settings', settings: {
        revision: options.thresholds ? editingRevision ?? data.settingsRevision : data.settingsRevision,
        enabled: options.enabled ?? data.enabled, notifications: options.notifications ?? data.notifications,
        thresholds: { claude: thresholds.claude, codex: thresholds.codex },
      } });
      setEditingRevision(null);
      setNotice(options.enabled === false ? '保护已关闭，额度限制已解除；已暂停的任务不会自动继续。' :
        options.enabled === true ? '保护开关已开启，按当前用量立即检查。实际执行状态见页面顶部。' : '设置已保存并即时生效；额度保护暂停将在新读数满足条件后自动解除，手动暂停保持不变。');
      await load();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const loadCredits = useCallback(async (accountId: string, force = false) => {
    try {
      await rpc({ action: 'codex-credits', accountId, force });
      setCreditErrors(e => ({ ...e, [accountId]: '' }));
      await load();
    } catch (e) { setCreditErrors(prev => ({ ...prev, [accountId]: String(e) })); }
  }, [rpc, load]);
  useEffect(() => {
    for (const a of data?.accounts ?? []) {
      if (a.provider !== 'codex' || data?.codexCredits?.[a.id] || creditsRequested.current.has(a.id)) continue;
      creditsRequested.current.add(a.id);
      void loadCredits(a.id);
    }
  }, [data, loadCredits]);
  async function resetCodex(accountId: string, creditId: string) {
    if (resetInFlight.current) return;
    resetInFlight.current = true;
    const selection = JSON.stringify([accountId, creditId]);
    // Correlation ID only; the server persists a separate UUID for upstream idempotency.
    const requestId = resetRequests.current.get(selection) ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
    resetRequests.current.set(selection, requestId);
    setBusy(true); setNotice(''); setError('');
    try {
      const result = await rpc({ action: 'codex-reset', accountId, creditId, requestId });
      const outcome = String(result.outcome);
      if (outcome in RESET_OUTCOMES && outcome !== 'unknown') resetRequests.current.delete(selection);
      setNotice((RESET_OUTCOMES[outcome] ?? RESET_OUTCOMES.unknown) +
        (result.refreshIncomplete ? ' 卡片或额度尚未成功刷新，请点击“刷新额度”核对。' : ''));
      await load();
    } catch (e) {
      await loadCredits(accountId, true);
      setNotice(`Reset 未完成或结果待确认：${String(e)}。请核对所选卡片后再操作。`);
    }
    finally { resetInFlight.current = false; setBusy(false); }
  }
  async function refreshCodex(accountId: string) {
    setBusy(true);
    try { await rpc({ action: 'refresh' }); await loadCredits(accountId, true); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function act(action: 'refresh' | 'pause' | 'resume' | 'test-push', accountId?: string) {
    setBusy(true); setNotice(''); setError('');
    try {
      const result = await rpc({ action, accountId });
      if (action === 'test-push') setNotice(result.accepted ? '推送网关已受理，请在手机上确认实际送达。' : String(result.reason ?? '推送未被受理'));
      else if (action === 'resume') setNotice('限制已解除。请进入需要的原会话发送“继续”；不会自动启动所有任务。');
      await load();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  const status = protectionStatus(data, c);
  const settingsExpanded = settingsOpen || editingRevision !== null;
  const switchLocked = busy || !!error || editingRevision !== null;
  const toggleSettings = () => setSettingsOpen(o => !o);

  return <ScrollView style={{ backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24 }}>
    <View style={styles.page}>
      <View style={styles.between}>
        <View style={{ flex: 1, gap: 6 }}>
          <View style={[styles.pill, { backgroundColor: c.surface2 }]}>
            <View style={[styles.dot, { backgroundColor: status.color }]} />
            <Text style={{ color: status.color, fontSize: 12, fontWeight: '600' }}>{status.tag}</Text>
          </View>
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{status.line}</Text>
        </View>
        <IconButton c={c} icon="RefreshCw" label="刷新额度" disabled={busy} onPress={() => void act('refresh')} />
        <IconButton c={c} icon="Settings" label={settingsExpanded ? '收起设置' : '展开设置'} onPress={toggleSettings} />
      </View>

      {!!error && <Banner c={c} danger text={`连接或操作异常：${error}。当前显示可能已过期。`} />}
      {!!notice && <Banner c={c} text={notice} />}
      {!!data?.lastError && <Banner c={c} danger text={data.lastError} />}

      {data?.accounts.length === 0 && <Text style={[styles.note, { color: c.foregroundMuted }]}>暂无可识别账户，不能据此认定额度充足。请检查登录和额度数据源。</Text>}
      {data?.accounts.map(a => <AccountCard key={a.id} c={c} data={data} a={a} busy={busy}
        onToggle={() => void act(a.locked ? 'resume' : 'pause', a.id)}
        codex={a.provider === 'codex' ? { credits: data.codexCredits?.[a.id], error: creditErrors[a.id] ?? '',
          onReset: creditId => void resetCodex(a.id, creditId), onRefresh: () => void refreshCodex(a.id) } : undefined} />)}
      {data?.agents.some(a => a.protection === 'unmapped') && <Text style={[styles.note, { color: c.foregroundMuted }]}>部分会话无法确认账户归属，未计入已保护账户。</Text>}

      {!!data?.historicalAccounts?.length && <Card c={c}>
        <Pressable accessibilityRole="button" accessibilityLabel={historyOpen ? '收起历史账户' : '展开历史账户'}
          accessibilityState={{ expanded: historyOpen }} onPress={() => setHistoryOpen(o => !o)}
          style={[styles.between, { minHeight: 44 }]}>
          <Text style={[styles.cardTitle, { color: c.foregroundMuted }]}>历史账户 · {data.historicalAccounts.length}</Text>
          <Icon name={historyOpen ? 'ChevronUp' : 'ChevronDown'} size={18} color={c.foregroundMuted} />
        </Pressable>
        {historyOpen && <>
          <Text style={[styles.note, { color: c.foregroundMuted }]}>这些账户当前未被识别，原暂停状态仍保留。再次识别后会回到当前账户列表；不会自动与其他账号合并。</Text>
          {data.historicalAccounts.map(a => <View key={a.id} style={{ gap: 8 }}>
            <Divider c={c} />
            <Text selectable style={{ color: c.foreground }}>{a.provider === 'claude' ? 'Claude' : 'Codex'} · {a.label || '身份未确认'}</Text>
            <KeyValue c={c} label="保留状态" value={a.locked ? `已暂停 · ${a.reason}` : '未暂停'} />
            <KeyValue c={c} label="最后识别" value={a.lastSeenAt ? gmt8(a.lastSeenAt) + '（GMT+8）' : '未知'} />
          </View>)}
        </>}
      </Card>}

      {data && <Card c={c}>
        <Pressable accessibilityRole="button" accessibilityLabel={settingsExpanded ? '收起设置' : '展开设置'} onPress={toggleSettings} style={styles.between}>
          <Text style={[styles.cardTitle, { color: c.foreground }]}>设置</Text>
          <Icon name={settingsExpanded ? 'ChevronUp' : 'ChevronDown'} size={18} color={c.foregroundMuted} />
        </Pressable>
        {settingsExpanded && <>
          <Divider c={c} />
          <SwitchRow c={c} label="启用额度保护" value={data.enabled} disabled={switchLocked} onChange={enabled => void save({ enabled })}
            hint="开关即时保存。关闭会解除本机额度限制，不自动续跑；重新开启会立即检查，超过暂停线即暂停。" />
          <Divider c={c} />
          <SwitchRow c={c} label="手机额度通知" value={data.notifications} disabled={switchLocked} onChange={notifications => void save({ notifications })} />
          <ActionButton c={c} icon="Bell" label="测试手机通知" disabled={busy || !data.notifications} onPress={() => void act('test-push')} />
          <Divider c={c} />
          {THRESHOLD_ROWS.map(({ key: p, label }) => <View key={p} style={styles.between}>
            <Text style={{ color: c.foreground, fontSize: 15 }}>{label}</Text>
            <View style={[styles.row, { gap: 12 }]}>
              {(['warn', 'pause'] as const).map(k => <View key={k} style={[styles.row, { gap: 6 }]}>
                <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{k === 'warn' ? '预警' : '暂停'}</Text>
                <TextInput accessibilityLabel={`${label} ${k === 'warn' ? '预警百分比' : '自动暂停百分比'}`} keyboardType="decimal-pad" editable={!busy}
                  value={draft[p][k]} onChangeText={value => { setEditingRevision(r => r ?? data.settingsRevision); setDraft(d => ({ ...d, [p]: { ...d[p], [k]: value } })); }}
                  style={[styles.input, { color: c.foreground, backgroundColor: c.surface2, borderColor: c.border }]} />
                <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>%</Text>
              </View>)}
            </View>
          </View>)}
          <Text style={[styles.note, { color: c.foregroundMuted }]}>0 ≤ 预警 &lt; 自动暂停 ≤ 100。Claude 的 5 小时和周窗口分别判断，任一达到自己的暂停线即暂停；恢复需要两个窗口均低于各自恢复线。Codex 使用统一阈值，只判断实际返回的窗口。降低暂停线可能立即中断任务。</Text>
          {data.collectionPolicy && <Text style={[styles.note, { color: c.foregroundMuted }]}>已有有效读数时，缓存有效期 {data.collectionPolicy.freshMs / 60000} 分钟；期间继续按轮询节奏获取额度，持续无新有效读数直至缓存到期即暂停，不额外延长。查询恢复且满足恢复条件后自动解除异常暂停；手动暂停保持不变。</Text>}
          {editingRevision !== null && editingRevision !== data.settingsRevision && <Text style={[styles.note, { color: c.statusWarning }]}>另一设备已修改设置，请取消编辑后重新调整。</Text>}
          <View style={[styles.row, { gap: 8 }]}>
            <ActionButton c={c} primary label="保存阈值" disabled={busy || editingRevision === null || editingRevision !== data.settingsRevision}
              onPress={() => void save({ thresholds: true })} />
            {editingRevision !== null && <ActionButton c={c} label="取消编辑" disabled={busy} onPress={() => { setEditingRevision(null); setError(''); }} />}
          </View>
        </>}
      </Card>}

      <Text style={[styles.note, { color: c.foregroundMuted }]}>暂停只中断任务并限制新请求，保留原会话。手机通知不能保证即时送达，自动暂停不依赖是否阅读通知。</Text>
    </View>
  </ScrollView>;
}

type CodexProps = { credits?: CodexCredits; error: string; onReset(creditId: string): void; onRefresh(): void };

function AccountCard({ c, data, a, busy, onToggle, codex }: {
  c: Colors; data: Snapshot; a: Account; busy: boolean; onToggle(): void; codex?: CodexProps;
}) {
  const badge = accountBadge(data, a, c);
  const resumeHint = !data.enabled ? '额度保护已关闭' : !data.enforcementReady ? '执行层未就绪，请等待连接恢复' :
    !a.ready ? a.assessment.resumeReason ?? '额度尚未满足恢复条件，请刷新后重试' :
    a.assessment.usingCachedReading ? '上次有效读数仍在有效期内，可手动恢复；继续保护额度。' : '可手动恢复，之后进入原会话继续。';
  return <Card c={c}>
    <View style={styles.between}>
      <View style={[styles.row, { flex: 1, gap: 8 }]}>
        <ProviderIcon provider={a.provider} size={18} color={c.foreground} />
        <Text style={[styles.cardTitle, { color: c.foreground }]}>{a.provider === 'claude' ? 'Claude' : 'Codex'}</Text>
        <Text style={[styles.chip, { color: badge.color, borderColor: badge.color, borderWidth: 1 }]}>{badge.text}</Text>
      </View>
      <ActionButton c={c} icon={a.locked ? 'Play' : 'Pause'} label={a.locked ? '恢复此账户' : '暂停此账户'} onPress={onToggle}
        disabled={busy || !data.enabled || !data.enforcementReady || (a.locked && !a.ready)} />
    </View>
    {data.enabled && a.locked && <KeyValue c={c} label="原因" value={a.reason} />}
    {data.enabled && a.locked && <KeyValue c={c} label="执行结果" value={a.stopStatus === 'paused' ?
      a.stopDetails?.checkedCount === 0 ? '新请求已受限，本次未发现可中断的关联任务' : '本次已核验的关联任务已停止' :
      a.stopStatus === 'partial' ? '部分关联任务未停止或无法确认' : '正在确认关联任务的暂停结果'} />}
    {a.locked && <Text style={[styles.note, { color: a.ready ? c.foregroundMuted : c.statusWarning }]}>{resumeHint}</Text>}
    {data.enabled && a.locked && ['quota', 'unavailable'].includes(a.pauseCause ?? '') && <Text style={[styles.note, { color: c.foregroundMuted }]}>新读数确认所有受保护窗口满足恢复条件后，将自动解除暂停并通知；旧任务不会自动续跑。</Text>}
    {data.enabled && !a.locked && a.assessment.level === 'warning' && <Text style={[styles.note, { color: c.statusWarning }]}>额度预警，可随时手动暂停</Text>}
    {codex && <CodexCreditsInfo c={c} busy={busy} {...codex} />}
    {a.windows.map(w => <WindowRow key={w.id} c={c} label={w.id === 'weekly' ? '周' : '5 小时'} used={w.used} reset={w.reset}
      threshold={data.enabled ? thresholdFor(data, a.provider, w.id) : undefined} />)}
    {a.provider === 'codex' && a.windows.length === 1 && <Text style={[styles.note, { color: c.foregroundMuted }]}>仅保护当前返回的{a.windows[0].id === 'weekly' ? '周' : '5 小时'}额度；另一窗口未提供。</Text>}
    {(a.provider === 'claude' ? ['five_hour', 'weekly'] : ['weekly']).map(id => {
      const t = thresholdFor(data, a.provider, id);
      return <KeyValue key={id} c={c} label={a.provider === 'claude' ? `${id === 'weekly' ? '周' : '5 小时'}阈值` : '阈值'}
        value={t ? `预警 ${t.warn}% · 暂停 ${t.pause}%` : '未配置'} />;
    })}
    <KeyValue c={c} label="更新" value={formatAgo(a.fetchedAt)} />
    {!!a.error && <KeyValue c={c} label="采集异常" value={a.error} color={a.assessment.usingCachedReading ? c.statusWarning : c.statusDanger} />}
    {!!a.label && <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 13 }}>{a.label}</Text>}
    {codex && <View style={[styles.row, { justifyContent: 'flex-end' }]}>
      <ActionButton c={c} icon="RefreshCw" label="刷新额度" disabled={busy} onPress={codex.onRefresh} />
    </View>}
  </Card>;
}

export function CodexCreditsInfo({ c, busy, credits, error, onReset }: { c: Colors; busy: boolean } & CodexProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = credits?.credits.find(item => item.id === selectedId);
  const available = (item: CodexCredits['credits'][number]) => item.expiresAt === null || item.expiresAt > Date.now();
  if (!credits) return <Text style={[styles.note, { color: error ? c.statusDanger : c.foregroundMuted }]}>{error ? `重置卡读取失败：${error}` : '正在读取重置卡…'}</Text>;
  const plan = credits.planType ? credits.planType[0].toUpperCase() + credits.planType.slice(1) : '未知';
  return <View style={{ gap: 8 }}>
    {!!error && <Text style={[styles.note, { color: c.statusWarning }]}>{error}</Text>}
    <View style={[styles.row, { gap: 16, flexWrap: 'wrap' }]}>
      <View style={[styles.row, { gap: 6 }]}>
        <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>套餐</Text>
        <Text style={[styles.chip, { color: c.foreground, backgroundColor: c.surface2, fontWeight: '600' }]}>{plan}</Text>
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>Credit 余额 <Text style={{ color: c.foreground, fontWeight: '600' }}>{credits.creditBalance?.toLocaleString() ?? '—'}</Text></Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>主动重置次数 <Text style={{ color: c.foreground, fontWeight: '600' }}>{credits.availableCount}</Text></Text>
    </View>
    {credits.credits.length > 0 && <>
      <Text style={{ color: c.foregroundMuted, fontSize: 13, fontWeight: '600' }}>主动重置过期时间（GMT+8）</Text>
      {credits.credits.map((item, i) => <View key={item.id} style={[styles.between, styles.creditRow, { borderColor: c.border }]}>
        <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>第 {i + 1} 张</Text>
        <View style={[styles.row, { gap: 12, justifyContent: 'flex-end', flexWrap: 'wrap', flex: 1 }]}>
          <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>
            {item.expiresAt ? <>{gmt8(item.expiresAt)} · <Text style={{ color: c.foreground, fontWeight: '600' }}>{until(item.expiresAt)}</Text></> : '不过期'}
          </Text>
          <ActionButton c={c} label="Reset" disabled={busy || !available(item)} onPress={() => setSelectedId(item.id)} />
        </View>
      </View>)}
    </>}
    {!credits.credits.length && <Text style={[styles.note, { color: c.foregroundMuted }]}>暂无可用的重置卡。</Text>}
    {selectedId !== null && <View style={{ gap: 8 }}>
      <View style={[styles.banner, { backgroundColor: c.surface2, borderLeftColor: c.statusWarning }]}>
        <Text style={{ flex: 1, color: c.foreground, fontSize: 13 }}>
          {selected && available(selected)
            ? `确定使用第 ${credits.credits.findIndex(item => item.id === selectedId) + 1} 张重置卡？${selected.expiresAt ? `到期时间：${gmt8(selected.expiresAt)}（GMT+8）。` : ''}操作不可撤回。`
            : '所选重置卡已过期或不可用，请取消后重新选择。'}
        </Text>
      </View>
      <View style={[styles.row, { gap: 8, justifyContent: 'flex-end' }]}>
        <ActionButton c={c} label="取消" disabled={busy} onPress={() => setSelectedId(null)} />
        <ActionButton c={c} primary label="Reset" disabled={busy || !selected || !available(selected)}
          onPress={() => { if (selected && available(selected)) { setSelectedId(null); onReset(selected.id); } }} />
      </View>
    </View>}
  </View>;
}

function WindowRow({ c, label, used, reset, threshold }: { c: Colors; label: string; used: number; reset: string | null; threshold?: Threshold }) {
  const pct = Math.max(0, Math.min(100, used));
  const resetText = formatReset(reset);
  const fill = !threshold ? c.accent : used >= threshold.pause ? c.statusDanger : used >= threshold.warn ? c.statusWarning : c.statusSuccess;
  const exact = reset && !Number.isNaN(Date.parse(reset)) ? `（${new Date(reset).toLocaleString()}）` : '';
  return <View accessible accessibilityLabel={`${label}额度已用 ${used}%，${resetText}${exact}`} style={[styles.window, { backgroundColor: c.surface2 }]}>
    <View style={styles.between}>
      <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>{label}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>
        <Text style={{ color: c.foreground, fontWeight: '600' }}>{used}%</Text> · {resetText}
      </Text>
    </View>
    <View style={styles.track}>
      <View style={[styles.fill, { width: '100%', backgroundColor: c.foregroundMuted, opacity: 0.2 }]} />
      <View style={[styles.fill, { width: `${pct}%`, backgroundColor: fill }]} />
      {threshold && [threshold.warn, threshold.pause].map((t, i) =>
        <View key={i} style={[styles.tick, { left: `${Math.max(0, Math.min(100, t))}%`, backgroundColor: c.foregroundMuted }]} />)}
    </View>
  </View>;
}

function Card({ c, children }: { c: Colors; children: ReactNode }) {
  return <View style={[styles.card, { backgroundColor: c.surface1, borderColor: c.border }]}>{children}</View>;
}

function Divider({ c }: { c: Colors }) {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />;
}

function KeyValue({ c, label, value, color }: { c: Colors; label: string; value: string; color?: string }) {
  return <View style={[styles.between, { alignItems: 'flex-start' }]}>
    <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>{label}</Text>
    <Text style={{ flexShrink: 1, textAlign: 'right', color: color ?? c.foreground, fontSize: 14 }}>{value}</Text>
  </View>;
}

function Banner({ c, text, danger }: { c: Colors; text: string; danger?: boolean }) {
  const color = danger ? c.statusDanger : c.accent;
  return <View style={[styles.banner, { backgroundColor: c.surface1, borderLeftColor: color }]}>
    <Icon name={danger ? 'CircleAlert' : 'Info'} size={16} color={color} />
    <Text style={{ flex: 1, color: c.foreground, fontSize: 14 }}>{text}</Text>
  </View>;
}

function SwitchRow({ c, label, hint, value, disabled, onChange }: {
  c: Colors; label: string; hint?: string; value: boolean; disabled: boolean; onChange(value: boolean): void;
}) {
  return <View style={styles.between}>
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ color: c.foreground, fontSize: 15 }}>{label}</Text>
      {!!hint && <Text style={[styles.note, { color: c.foregroundMuted }]}>{hint}</Text>}
    </View>
    <Switch accessibilityLabel={label} value={value} disabled={disabled} trackColor={{ false: c.border, true: c.accent }} onValueChange={onChange} />
  </View>;
}

function IconButton({ c, icon, label, onPress, disabled }: { c: Colors; icon: string; label: string; onPress(): void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} hitSlop={6}
    style={({ pressed }) => [styles.iconButton, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
    <Icon name={icon} size={18} color={c.foregroundMuted} />
  </Pressable>;
}

function ActionButton({ c, label, icon, primary, onPress, disabled }: {
  c: Colors; label: string; icon?: string; primary?: boolean; onPress(): void; disabled: boolean;
}) {
  const fg = primary ? c.accentForeground : c.foreground;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, {
    backgroundColor: primary ? c.accent : 'transparent', borderColor: primary ? c.accent : c.border, opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
  }]}>
    {icon && <Icon name={icon} size={14} color={fg} />}
    <Text style={{ color: fg, fontSize: 13, fontWeight: '500' }}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  page: { width: '100%', maxWidth: 760, alignSelf: 'center', gap: 16 },
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  card: { borderWidth: 1, borderRadius: 12, padding: 16, gap: 12 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  note: { fontSize: 12, lineHeight: 18 },
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  chip: { fontSize: 12, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  window: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  track: { height: 4, borderRadius: 2 },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2 },
  tick: { position: 'absolute', top: -2, width: 1, height: 8, opacity: 0.6 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 8, borderLeftWidth: 3 },
  input: { width: 56, height: 32, borderWidth: 1, borderRadius: 8, textAlign: 'center', padding: 0, fontSize: 14 },
  iconButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  sidebarRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 8 },
  creditRow: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9 },
  button: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
});
