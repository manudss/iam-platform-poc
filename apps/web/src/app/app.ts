import { Branding } from './branding';
import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** Root: only the router outlet. Pages live under the routes (login, then the administration shell). */
@Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet />' })
export class App { private readonly branding = inject(Branding); }
