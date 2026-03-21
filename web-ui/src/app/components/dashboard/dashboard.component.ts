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

  constructor() {
    console.log(`[INIT] ${new Date().toISOString()} DashboardComponent initialized`);
  }

  setTab(tab: 'mcp' | 'llm' | 'chat' | 'workspace'): void {
    this.activeTab = tab;
    if (tab === 'chat') {
      this.chatComp?.loadSidebar();
    }
  }
}
