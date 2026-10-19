import type { PluginClientContext } from '@getpaseo/plugin/client';
import { Dashboard, Sidebar } from './client/main';

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: 'dashboard', title: '额度保护', Component: Dashboard });
  client.addSidebarFooterItem({ id: 'quota-guard', title: '额度保护', Component: Sidebar });
  client.addSlashCommand({ name: 'quota', description: '查看额度并暂停或恢复账户', argumentHint: '', context: 'agent',
    onSubmit(context) { context.openScreen({ screenId: 'dashboard' }); } });
  return () => {};
}
