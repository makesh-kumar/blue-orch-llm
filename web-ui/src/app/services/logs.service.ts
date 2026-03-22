import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface LogEntry {
  level:     string;
  message:   string;
  timestamp: string;
}

@Injectable({ providedIn: 'root' })
export class LogsService {
  private readonly baseUrl = `${environment.apiUrl}/api/logs`;

  constructor(private http: HttpClient) {}

  // Fetch recent buffered logs (one-shot HTTP)
  getRecentLogs(limit = 300, level = 'all'): Observable<{ logs: LogEntry[]; total: number }> {
    return this.http.get<{ logs: LogEntry[]; total: number }>(
      `${this.baseUrl}?limit=${limit}&level=${level}`
    );
  }

  // Returns an Observable that wraps a native EventSource (SSE)
  streamLogs(): Observable<LogEntry> {
    return new Observable<LogEntry>(observer => {
      const es = new EventSource(`${this.baseUrl}/stream`);

      es.onmessage = (event: MessageEvent) => {
        try {
          const entry: LogEntry = JSON.parse(event.data);
          observer.next(entry);
        } catch { /* skip malformed frames */ }
      };

      es.onerror = () => {
        // EventSource auto-reconnects; only complete if explicitly closed
      };

      return () => { es.close(); };
    });
  }
}
