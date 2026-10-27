import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('IAM platform POC');
  protected readonly status = signal('Console skeleton: not connected to the API yet.');
}
