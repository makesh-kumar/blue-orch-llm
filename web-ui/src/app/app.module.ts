import { NgModule, SecurityContext } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule } from '@angular/common/http';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MARKED_OPTIONS, MarkdownModule, MarkedOptions, MarkedRenderer } from 'ngx-markdown';
import hljs from 'highlight.js';

import { AppComponent } from './app.component';
import { DashboardComponent } from './components/dashboard/dashboard.component';
import { McpConfigComponent } from './components/mcp-config/mcp-config.component';
import { LlmConfigComponent } from './components/llm-config/llm-config.component';
import { ChatComponent } from './components/chat/chat.component';
import { WorkspaceBarComponent } from './components/workspace-bar/workspace-bar.component';

// ─── Custom Marked renderer ────────────────────────────────────────────────────────────
// Must be an exported named function (not lambda) for AOT compatibility.
export function markedOptionsFactory(): MarkedOptions {
  const renderer = new MarkedRenderer();

  // Override fenced code block rendering
  (renderer as any).code = (code: string, language: string | undefined): string => {
    console.log(`[INIT] ${new Date().toISOString()} markedRenderer.code | lang: ${language ?? 'auto'}`);

    const lang = language && hljs.getLanguage(language) ? language : '';

    let highlighted: string;
    try {
      highlighted = lang
        ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(code).value;
    } catch {
      highlighted = code
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    const langLabel = (language || 'code').toUpperCase();

    // Wrap each line in a span so CSS can render line numbers
    const lines = highlighted.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const codeLines = lines
      .map(l => `<span class="code-line">${l || ' '}</span>`)
      .join('\n');

    // Self-contained copy fn using only single quotes (safe in onclick="...")
    // NOTE: onclick is stripped by Angular DomSanitizer — copy is handled via
    // event delegation in ChatComponent (@HostListener). Button uses data-copy-btn.
    const _copyFn = ''; // kept for reference only, not used

    console.log(`[SUCCESS] ${new Date().toISOString()} markedRenderer.code | ${lines.length} lines`);

    return [
      `<div class="code-block">`,
      `<div class="code-header">`,
      `<span class="code-lang-label">${langLabel}</span>`,
      `<button class="code-copy-btn" data-copy-btn="true">Copy</button>`,
      `</div>`,
      `<pre class="code-pre"><code class="hljs language-${lang || 'plaintext'}">${codeLines}</code></pre>`,
      `</div>`,
    ].join('');
  };

  return { renderer };
}

// ─── Module ────────────────────────────────────────────────────────────────────────────
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
    MarkdownModule.forRoot({
      sanitize: SecurityContext.NONE,
      markedOptions: {
        provide: MARKED_OPTIONS,
        useFactory: markedOptionsFactory,
      },
    }),
  ],
  providers: [],
  bootstrap: [AppComponent],
})
export class AppModule { }
