import { ServiceUnavailableException } from '@nestjs/common';

// Capture before Nest creates any services. Invalid presence cannot start unheld.
const configured = process.env.IAM_AUTOMATION_HOLD;
if (configured !== undefined && configured !== '1') {
  throw new Error('IAM_AUTOMATION_HOLD must be absent or exactly 1; invalid configuration refuses startup');
}
export const automationHeld = configured === '1';
export const automationHoldStatus = Object.freeze({ held: automationHeld, settingPresent: configured !== undefined, restartRequired: true });
export function assertAutomationAllowed(): void {
  if (automationHeld) throw new ServiceUnavailableException('AUTOMATION_HELD: workflows and automatic activation effects are suspended by startup configuration');
}
