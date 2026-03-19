import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule } from '@angular/common/http';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';

import { AppComponent } from './app.component';
import { DashboardComponent } from './components/dashboard/dashboard.component';
import { McpConfigComponent } from './components/mcp-config/mcp-config.component';
import { LlmConfigComponent } from './components/llm-config/llm-config.component';
import { ChatComponent } from './components/chat/chat.component';
import { WorkspaceBarComponent } from './components/workspace-bar/workspace-bar.component';

@NgModule({
  declarations: [
    AppComponent,
    DashboardComponent,
    McpConfigComponent,
    LlmConfigComponent,
    ChatComponent,
    WorkspaceBarComponent,
  ],
  imports: [
    BrowserModule,
    HttpClientModule,
    FormsModule,
    ReactiveFormsModule,
  ],
  providers: [],
  bootstrap: [AppComponent],
})
export class AppModule { }
