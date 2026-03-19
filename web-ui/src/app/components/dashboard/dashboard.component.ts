import { Component, ViewChild } from '@angular/core';
import { ChatComponent } from '../chat/chat.component';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent {
  @ViewChild(ChatComponent) private chatComp?: ChatComponent;

  activeTab: 'mcp' | 'llm' | 'chat' = 'mcp';

  constructor() {
    console.log(`[INIT] ${new Date().toISOString()} DashboardComponent initialized`);
  }

  setTab(tab: 'mcp' | 'llm' | 'chat'): void {
    this.activeTab = tab;
    if (tab === 'chat') {
      // Refresh sidebar so newly added LLM/MCP entries are reflected immediately
      this.chatComp?.loadSidebar();
    }
  }
}
