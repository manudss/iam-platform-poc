import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { preloadLaunchpadChunk } from './app/launchpad-preload';

// Every visitor here is signing in or signed in, and the signed-in landing is My applications: start its code
// chunk during bootstrap instead of after the router has resolved. The session itself is an HttpOnly cookie the
// browser cannot read, so there is no synchronous hint to gate on - and warming a static chunk leaks nothing.
// (The data request follows in Session, once the client exists and only with a live session.)
void preloadLaunchpadChunk();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
