import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

// ─── Models ───────────────────────────────────────────────────────────────────

export interface StandardizedUsage {
  input: number;
  output: number;
  cached: number;
  model: string;
  provider: string;
  latencyMs: number;
  /** Tokens per second reported by LM Studio's hardware stats. */
  tokensPerSecond?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: string[];
  timestamp: string;
  standardizedUsage?: StandardizedUsage | null;
  turnCost?: number;
}

export interface ActiveTool {
  connectionId: string;
  toolName: string;
}

export interface SendChatRequest {
  message: string;
  providerId: string;
  activeTools: ActiveTool[];
  systemContext?: string;
  /** Absolute workspace path. Sent only when Project Mode is active.
   *  Triggers context caching on the backend for Gemini providers. */
  activeWorkspacePath?: string;
}

export interface SendChatResponse {
  reply: string;
  toolsUsed: string[];
  standardizedUsage: StandardizedUsage | null;
}

export interface ChatHistoryResponse {
  history: { role: string; content: string; toolsUsed?: string[]; standardizedUsage?: StandardizedUsage | null }[];
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly apiUrl = `${environment.apiUrl}/api/chat`;

  constructor(private http: HttpClient) {
    console.log(`[INIT] ${new Date().toISOString()} ChatService initialized | apiUrl: ${this.apiUrl}`);
  }

  send(request: SendChatRequest): Observable<SendChatResponse> {
    console.log(`[INIT] ${new Date().toISOString()} ChatService.send() | providerId: ${request.providerId} | tools: ${request.activeTools.length}`);
    return this.http
      .post<SendChatResponse>(`${this.apiUrl}/send`, request)
      .pipe(tap(res => console.log(`[SUCCESS] ${new Date().toISOString()} ChatService.send() | toolsUsed: [${res.toolsUsed.join(', ')}]`)));
  }

  getHistory(): Observable<ChatHistoryResponse> {
    console.log(`[INIT] ${new Date().toISOString()} ChatService.getHistory()`);
    return this.http
      .get<ChatHistoryResponse>(`${this.apiUrl}/history`)
      .pipe(tap(res => console.log(`[SUCCESS] ${new Date().toISOString()} ChatService.getHistory() | ${res.history.length} messages`)));
  }

  clearHistory(): Observable<{ success: boolean }> {
    console.log(`[INIT] ${new Date().toISOString()} ChatService.clearHistory()`);
    return this.http
      .delete<{ success: boolean }>(`${this.apiUrl}/history`)
      .pipe(tap(() => console.log(`[SUCCESS] ${new Date().toISOString()} ChatService.clearHistory()`)));
  }
}
