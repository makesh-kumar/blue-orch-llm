import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { LlmService, LlmRegistryEntry, LlmVerifyResponse } from '../../services/llm.service';

// ─── LLM model map ─────────────────────────────────────────────────────────────
const MODEL_MAP: Record<string, { label: string; value: string }[]> = {
  gemini: [
    { label: 'Gemini 1.5 Flash', value: 'gemini-1.5-flash' },
    { label: 'Gemini 1.5 Pro',   value: 'gemini-1.5-pro' },
    {label: 'Gemini 2.0 Flash',value: 'gemini-2.0-flash'},
    {label: 'Gemini 2.0 Flash Lite',value: 'gemini-2.0-flash-lite'},
    { label: 'Other',            value: 'other' },
  ],
  openai: [
    { label: 'GPT-4o',      value: 'gpt-4o' },
    { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
    { label: 'Other',       value: 'other' },
  ],
  claude: [
    { label: 'Claude 3.5 Sonnet', value: 'claude-3-5-sonnet-20241022' },
    { label: 'Other',             value: 'other' },
  ],
};

@Component({
  selector: 'app-llm-config',
  templateUrl: './llm-config.component.html',
  styleUrls: ['./llm-config.component.scss'],
})
export class LlmConfigComponent implements OnInit {
  // ── Form
  llmForm!: FormGroup;
  modelOptions: { label: string; value: string }[] = [];

  // ── Verify status
  verifyStatus: 'idle' | 'verifying' | 'success' | 'error' = 'idle';
  verifyLatency: number | null = null;
  verifyError = '';

  // ── Registry
  registeredProviders: LlmRegistryEntry[] = [];

  constructor(
    private llmService: LlmService,
    private fb: FormBuilder,
  ) {
    const keyFromLocalStorage = localStorage.getItem('gKey') ?? '';
    console.log(`[INIT] ${new Date().toISOString()} LlmConfigComponent initialized`);
    this.llmForm = this.fb.group({
      provider:    ['', Validators.required],
      model:       ['', Validators.required],
      customModel: [''],
      apiKey:      [keyFromLocalStorage, Validators.required],
    });
  }

  ngOnInit(): void {
    this.loadRegistry();
  }

  // ── Load registry from backend ─────────────────────────────────────────────
  loadRegistry(): void {
    this.llmService.getRegistry().subscribe({
      next: (res) => {
        this.registeredProviders = res.registry;
        console.log(`[SUCCESS] ${new Date().toISOString()} Registry loaded | ${res.registry.length} entries`);
      },
      error: (err) => {
        console.log(`[ERROR] ${new Date().toISOString()} Failed to load registry | ${err.message}`);
      },
    });
  }

  // ── Provider change ────────────────────────────────────────────────────────
  onProviderChange(): void {
    const provider = this.llmForm.get('provider')!.value as string;
    this.modelOptions = MODEL_MAP[provider] ?? [];
    this.llmForm.patchValue({ model: '', customModel: '' });
    this.verifyStatus = 'idle';
    this.verifyLatency = null;
    this.verifyError = '';
    console.log(`[INIT] ${new Date().toISOString()} Provider changed | provider: ${provider}`);
  }

  get isCustomModel(): boolean {
    return this.llmForm.get('model')!.value === 'other';
  }

  // ── Provider display helpers ───────────────────────────────────────────────
  providerLabel(provider: string): string {
    const map: Record<string, string> = { gemini: 'Gemini', openai: 'OpenAI', claude: 'Claude' };
    return map[provider] ?? provider;
  }

  providerIconClass(provider: string): string {
    const map: Record<string, string> = { gemini: 'bi-google', openai: 'bi-robot', claude: 'bi-cpu' };
    return map[provider] ?? 'bi-box';
  }

  formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString();
  }

  // ── Verify & Save ──────────────────────────────────────────────────────────
  verifyLlm(): void {
    if (this.llmForm.invalid) {
      this.llmForm.markAllAsTouched();
      return;
    }
    const { provider, model, customModel, apiKey } = this.llmForm.value as {
      provider: string; model: string; customModel: string; apiKey: string;
    };
    const resolvedModel = model === 'other' ? customModel.trim() : model;
    if (!resolvedModel) {
      this.llmForm.get('customModel')!.setErrors({ required: true });
      return;
    }

    this.verifyStatus = 'verifying';
    this.verifyLatency = null;
    this.verifyError = '';
    console.log(`[INIT] ${new Date().toISOString()} verifyLlm() | provider: ${provider} | model: ${resolvedModel}`);

    this.llmService.verify({ provider, model: resolvedModel, apiKey }).subscribe({
      next: (res: LlmVerifyResponse) => {
        this.verifyStatus = 'success';
        this.verifyLatency = res.latency;
        // Add to local registry list
        this.registeredProviders.push({
          id: res.id,
          provider: res.provider,
          model: res.model,
          latency: res.latency,
          verifiedAt: res.verifiedAt,
        });
        // Clear sensitive input, keep provider/model for quick re-use
        this.llmForm.patchValue({ apiKey: '' });
        this.llmForm.get('apiKey')!.markAsUntouched();
        console.log(`[SUCCESS] ${new Date().toISOString()} LLM added to registry | id: ${res.id} | latency: ${res.latency}ms`);
      },
      error: (err) => {
        this.verifyStatus = 'error';
        this.verifyLatency = err.error?.latency ?? null;
        this.verifyError = err.error?.error ?? 'Verification failed. Check your API key.';
        console.log(`[ERROR] ${new Date().toISOString()} LLM verification failed | ${this.verifyError}`);
      },
    });
  }

  // ── Delete registry entry ──────────────────────────────────────────────────
  deleteEntry(id: string): void {
    this.llmService.deleteEntry(id).subscribe({
      next: (res) => {
        this.registeredProviders = this.registeredProviders.filter(e => e.id !== id);
        console.log(`[SUCCESS] ${new Date().toISOString()} Registry entry deleted | id: ${id}`);
      },
      error: (err) => {
        console.log(`[ERROR] ${new Date().toISOString()} Failed to delete entry | ${err.message}`);
      },
    });
  }
}
