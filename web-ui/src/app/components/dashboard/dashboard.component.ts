import { Component, ViewChild } from '@angular/core';
import { ChatComponent } from '../chat/chat.component';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent {
  @ViewChild(ChatComponent) private chatComp?: ChatComponent;

  activeTab: 'mcp' | 'llm' | 'chat' | 'workspace' = 'mcp';
  isDarkMode = false;

  constructor() {
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
}
