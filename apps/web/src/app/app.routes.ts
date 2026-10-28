import { Routes } from '@angular/router';

// No pages: the console is one component. The catch-all keeps the router quiet on /callback (the sign-in return URL).
export const routes: Routes = [{ path: '**', children: [] }];
