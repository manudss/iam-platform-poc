import { AsyncPlugin, AsyncPluginEvent } from './plugin.contract.js';

/** Example async plugin: tells the (fictional) manager after a role change. No real mail is sent in v0. */
export class NotifyManagerPlugin implements AsyncPlugin {
  name = 'notify-manager';
  handles(e: AsyncPluginEvent) {
    return e.type === 'role.changed';
  }
  async run(e: AsyncPluginEvent) {
    return {
      effectKey: `${e.tenant}:${e.activation}:notify-manager:${e.subject}`,
      detail: `would notify manager: ${e.subject} is now ${e.newRole}`,
    };
  }
}
