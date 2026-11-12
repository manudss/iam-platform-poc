import { ConnectionProvider } from './wf-model';
export const managedProvider = (type: string): ConnectionProvider | null => type.startsWith('google-sheets-') ? 'google-sheets' : type.startsWith('jira-') ? 'jira' : type === 'http-request' ? 'http' : null;
/** Any action or connection edit invalidates a previous Real confirmation. */
export function editedAction(type: string, config: Record<string,unknown>, key: string, value: unknown) {
  return {...config,[key]:value,...(managedProvider(type) ? {executionMode:'simulation',realConfirmed:false} : {})};
}
export function simulatedAction(config: Record<string,unknown>) { return {...config,executionMode:'simulation',realConfirmed:false}; }
