import { clientFor } from './mcp.js';
import type { ServerCfg } from './types.js';

export async function deployApp(server: ServerCfg, appUuid: string): Promise<string> {
  const client = clientFor(server);
  const res = await client.tool<{ data?: { deployment_uuid?: string } }>('deploy', { uuid: appUuid });
  const deployment = res?.data?.deployment_uuid;
  return deployment ? `deploy encolado: ${deployment}` : 'deploy encolado';
}

export async function controlApp(
  server: ServerCfg,
  appUuid: string,
  action: 'start' | 'stop' | 'restart',
): Promise<string> {
  const client = clientFor(server);
  await client.tool('control', {
    resource: 'application',
    action,
    uuid: appUuid,
    ...(action === 'stop' ? { confirm: true } : {}),
  });
  return `${action} ejecutado`;
}

export async function deleteApp(server: ServerCfg, appUuid: string): Promise<string> {
  const client = clientFor(server);
  await client.tool('manage_application', {
    action: 'delete',
    uuid: appUuid,
    confirm: true,
    data: {
      delete_volumes: false,
      delete_connected_networks: true,
      delete_configurations: true,
      docker_cleanup: false,
    },
  });
  return 'aplicación eliminada';
}

export async function appLogs(server: ServerCfg, appUuid: string, lines = 60): Promise<string> {
  const client = clientFor(server);
  const res = await client.tool<{ data?: { logs?: string } | string }>('get_logs', {
    resource: 'application',
    uuid: appUuid,
    lines,
  });
  const data = res?.data;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && typeof data.logs === 'string') return data.logs;
  return JSON.stringify(res).slice(0, 3500);
}

export async function deploymentDetail(server: ServerCfg, uuid: string): Promise<string> {
  const client = clientFor(server);
  const res = await client.tool<{ data?: Record<string, unknown> }>('get_deployment', {
    uuid,
    include_log_summary: true,
  });
  const data = res?.data ?? {};
  const status = String(data['status'] ?? 'desconocido');
  const summary = data['log_summary'] ?? data['logs'] ?? '';
  return `deployment ${uuid} → ${status}${summary ? `\n\n${String(summary).slice(0, 3000)}` : ''}`;
}
