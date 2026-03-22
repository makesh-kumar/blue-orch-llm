import { Component, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ChatComponent } from '../chat/chat.component';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent {
  @ViewChild(ChatComponent) private chatComp?: ChatComponent;

  activeTab: 'mcp' | 'llm' | 'chat' | 'workspace' = 'mcp';
  isDarkMode = false;
  isRestarting = false;

  private readonly apiUrl = `${environment.apiUrl}/api/system`;

  constructor(private http: HttpClient) {
    console.log(`[INIT] ${new Date().toISOString()} DashboardComponent initialized`);
    const saved = localStorage.getItem('blueorchstudio-dark-mode');
    this.isDarkMode = saved === 'true';
    this._applyTheme();
  }

  setTab(tab: 'mcp' | 'llm' | 'chat' | 'workspace'): void {
    this.activeTab = tab;
    if (tab === 'chat') {
      this.chatComp?.loadSidebar();
    }
  }

  toggleDarkMode(): void {
    this.isDarkMode = !this.isDarkMode;
    localStorage.setItem('blueorchstudio-dark-mode', String(this.isDarkMode));
    this._applyTheme();
    console.log(`[SUCCESS] ${new Date().toISOString()} DashboardComponent: dark mode ${this.isDarkMode ? 'ON' : 'OFF'}`);
  }

  private _applyTheme(): void {
    document.documentElement.classList.toggle('dark', this.isDarkMode);
  }

  restartServer(): void {
    if (this.isRestarting) return;
    this.isRestarting = true;
    this.http.post(`${this.apiUrl}/restart`, {}).subscribe({
      next: () => this._pollUntilUp(),
      error: () => this._pollUntilUp(), // server may cut the connection before responding
    });
  }

  private _pollUntilUp(): void {
    const maxAttempts = 30;
    let attempts = 0;
    const poll = () => {
      attempts++;
      this.http.get(`${this.apiUrl}/health`).subscribe({
        next:  () => { this.isRestarting = false; window.location.reload(); },
        error: () => {
          if (attempts < maxAttempts) setTimeout(poll, 1000);
          else this.isRestarting = false;
        },
      });
    };
    setTimeout(poll, 1500); // give the old process time to exit first
  }
}
