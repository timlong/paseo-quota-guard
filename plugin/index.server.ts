import type { PluginServerContext } from '@getpaseo/plugin/server';
import { control } from './shared/rpc';
import { handleControl } from './server/control';

export default function contribute(server: PluginServerContext) {
  server.handle(control, handleControl);
  return () => {};
}
