import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

// ─── Models ───────────────────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, { type: string; description?: string; items?: unknown }>;
    required?: string[];
  };
}

export interface ActiveConnection {
  connectionId: string;
  label: string;
  command: string;
  args: string[];
  toolCount: number;
}

export interface ConnectResponse {
  connectionId: string;
  label: string;
  command: string;
  args: string[];
  tools: McpTool[];
}

export interface ToolsResponse {
  connectionId: string;
  tools: McpTool[];
}

export interface ExecuteResponse {
  connectionId: string;
  toolName: string;
  result: unknown;
}

export interface LogsResponse {
  connectionId: string;
  logs: string[];
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class McpService {
  private readonly apiUrl = 'http://localhost:3000/api';

  constructor(private http: HttpClient) {
    console.log(`[INIT] ${new Date().toISOString()} McpService initialized | apiUrl: ${this.apiUrl}`);
  }

  connect(command: string, args: string[]): Observable<ConnectResponse> {
    console.log(`[INIT] ${new Date().toISOString()} McpService.connect() | command: ${command} | args: ${args.join(' ')}`);
    return this.http
      .post<ConnectResponse>(`${this.apiUrl}/connect`, { command, args })
      .pipe(tap(res => console.log(`[SUCCESS] ${new Date().toISOString()} McpService.connect() | id: ${res.connectionId}`)));
  }

  getTools(connectionId: string): Observable<ToolsResponse> {
    console.log(`[INIT] ${new Date().toISOString()} McpService.getTools() | id: ${connectionId}`);
    return this.http
      .get<ToolsResponse>(`${this.apiUrl}/tools/${connectionId}`)
      .pipe(tap(res => console.log(`[SUCCESS] ${new Date().toISOString()} McpService.getTools() | ${res.tools.length} tools`)));
  }

  execute(connectionId: string, toolName: string, args: object): Observable<ExecuteResponse> {
    console.log(`[INIT] ${new Date().toISOString()} McpService.execute() | tool: ${toolName}`);
    return this.http
      .post<ExecuteResponse>(`${this.apiUrl}/execute`, { connectionId, toolName, arguments: args })
      .pipe(tap(() => console.log(`[SUCCESS] ${new Date().toISOString()} McpService.execute() | tool: ${toolName}`)));
  }

  disconnect(connectionId: string): Observable<{ success: boolean }> {
    console.log(`[INIT] ${new Date().toISOString()} McpService.disconnect() | id: ${connectionId}`);
    return this.http.delete<{ success: boolean }>(`${this.apiUrl}/disconnect/${connectionId}`);
  }

  getLogs(connectionId: string): Observable<LogsResponse> {
    return this.http.get<LogsResponse>(`${this.apiUrl}/logs/${connectionId}`);
  }

  clearLogs(connectionId: string): Observable<{ success: boolean }> {
    console.log(`[INIT] ${new Date().toISOString()} McpService.clearLogs() | id: ${connectionId}`);
    return this.http.delete<{ success: boolean }>(`${this.apiUrl}/logs/${connectionId}/clear`);
  }
}
