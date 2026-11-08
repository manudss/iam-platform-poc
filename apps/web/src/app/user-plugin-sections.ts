import { Component, input } from '@angular/core';
import { ProfileComponents } from './profile-components';

/**
 * The Users drawer's plugin section (PROFILE-PLUGINS-SLOT seam, see users.ts): every profile component the active
 * plugins contribute to the admin surface (TOTP status + revoke, PIN provisioning, profile picture...), for the
 * user being edited. The base password stays in the drawer's Security section.
 */
@Component({
  selector: 'app-user-plugin-sections',
  imports: [ProfileComponents],
  styleUrl: './user-plugin-sections.css',
  template: `
  <div class="user-plugin-sections" id="user-plugin-sections">
    <h4>Security plugins</h4>
    <app-profile-components surface="admin" [subject]="userId()" />
  </div>`,
})
export class UserPluginSections {
  readonly userId = input.required<string>();
}
