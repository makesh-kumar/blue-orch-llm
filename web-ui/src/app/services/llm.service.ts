import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

// ─── Models ───────────────────────────────────────────────────────────────────

export interface LlmConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface LlmVerifyResponse {
  success: boolean;
  id: string;
  provider: string;
  model: string;
  latency: number;
  verifiedAt: string;
  error?: string;
}

export interface LlmRegistryEntry {
  id: string;
  provider: string;
  model: string;
  latency: number;
  verifiedAt: string;
}

export interface LlmRegistryResponse {
  registry: LlmRegistryEntry[];
  activeId: string | null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class LlmService {
  private readonly apiUrl = 'http://localhost:3000/api/llm';

  constructor(private http: HttpClient) {
    console.log(`[INIT] ${new Date().toISOString()} LlmService initialized | apiUrl: ${this.apiUrl}`);
  }

  verify(config: LlmConfig): Observable<LlmVerifyResponse> {
    console.log(`[INIT] ${new Date().toISOString()} LlmService.verify() | provider: ${config.provider} | model: ${config.model}`);
    return this.http
      .post<LlmVerifyResponse>(`${this.apiUrl}/verify`, config)
      .pipe(tap(res => console.log(`[SUCCESS] ${new Date().toISOString()} LlmService.verify() | id: ${res.id} | latency: ${res.latency}ms`)));
  }

  getRegistry(): Observable<LlmRegistryResponse> {
    console.log(`[INIT] ${new Date().toISOString()} LlmService.getRegistry()`);
    return this.http
      .get<LlmRegistryResponse>(`${this.apiUrl}/registry`)
      .pipe(tap(res => console.log(`[SUCCESS] ${new Date().toISOString()} LlmService.getRegistry() | ${res.registry.length} entries`)));
  }

  setActive(id: string): Observable<{ success: boolean; activeId: string }> {
    console.log(`[INIT] ${new Date().toISOString()} LlmService.setActive() | id: ${id}`);
    return this.http
      .put<{ success: boolean; activeId: string }>(`${this.apiUrl}/active/${id}`, {})
      .pipe(tap(() => console.log(`[SUCCESS] ${new Date().toISOString()} LlmService.setActive() | id: ${id}`)));
  }

  deleteEntry(id: string): Observable<{ success: boolean; activeId: string | null }> {
    console.log(`[INIT] ${new Date().toISOString()} LlmService.deleteEntry() | id: ${id}`);
    return this.http
      .delete<{ success: boolean; activeId: string | null }>(`${this.apiUrl}/${id}`)
      .pipe(tap(res => console.log(`[SUCCESS] ${new Date().toISOString()} LlmService.deleteEntry() | new activeId: ${res.activeId}`)));
  }

  fetchOllamaModels(baseUrl: string): Observable<{ models: { name: string; size: number }[] }> {
    console.log(`[INIT] ${new Date().toISOString()} LlmService.fetchOllamaModels() | baseUrl: ${baseUrl}`);
    return this.http
      .get<{ models: { name: string; size: number }[] }>(
        `${this.apiUrl}/ollama/models?baseUrl=${encodeURIComponent(baseUrl)}`
      )
      .pipe(tap(res => console.log(`[SUCCESS] ${new Date().toISOString()} LlmService.fetchOllamaModels() | ${res.models.length} models`)));
  }

  fetchLmStudioModels(baseUrl?: string): Observable<{ models: { id: string }[] }> {
    const url = baseUrl
      ? `${this.apiUrl}/lmstudio/models?baseUrl=${encodeURIComponent(baseUrl)}`
      : `${this.apiUrl}/lmstudio/models`;
    console.log(`[INIT] ${new Date().toISOString()} LlmService.fetchLmStudioModels() | baseUrl: ${baseUrl ?? 'default'}`);
    return this.http
      .get<{ models: { id: string }[] }>(url)
      .pipe(tap(res => console.log(`[SUCCESS] ${new Date().toISOString()} LlmService.fetchLmStudioModels() | ${res.models.length} models`)));
  }

  fetchCloudModels(provider: string, apiKey: string): Observable<{ models: { label: string; value: string }[] }> {
    console.log(`[INIT] ${new Date().toISOString()} LlmService.fetchCloudModels() | provider: ${provider}`);
    return this.http
      .post<{ models: { label: string; value: string }[] }>(`${this.apiUrl}/models`, { provider, apiKey })
      .pipe(tap(res => console.log(`[SUCCESS] ${new Date().toISOString()} LlmService.fetchCloudModels() | ${res.models.length} models`)));
  }
}

