import { Component, Input } from '@angular/core';
import { StandardizedUsage } from '../../services/chat.service';
import { UsageCalculatorService } from '../../services/usage-calculator.service';

@Component({
  selector: 'app-usage-badge',
  templateUrl: './usage-badge.component.html',
  styleUrls: ['./usage-badge.component.scss'],
})
export class UsageBadgeComponent {
  @Input() usage: StandardizedUsage | null = null;
  @Input() cost: number = 0;

  constructor(private usageCalc: UsageCalculatorService) {
    console.log(`[INIT] ${new Date().toISOString()} UsageBadgeComponent initialized`);
  }

  get isOllama(): boolean {
    return this.usage?.provider === 'ollama';
  }

  get providerIconClass(): string {
    const icons: Record<string, string> = {
      gemini: 'bi-google',
      openai: 'bi-robot',
      claude: 'bi-cpu',
      ollama: 'bi-hdd-stack',
    };
    return `bi ${icons[this.usage?.provider ?? ''] ?? 'bi-box'}`;
  }

  get inputDisplay(): string {
    return this.usageCalc.formatTokens(this.usage?.input ?? 0);
  }

  get outputDisplay(): string {
    return this.usageCalc.formatTokens(this.usage?.output ?? 0);
  }

  get cachedDisplay(): string {
    return this.usageCalc.formatTokens(this.usage?.cached ?? 0);
  }

  get hasCached(): boolean {
    return (this.usage?.cached ?? 0) > 0;
  }

  get costDisplay(): string {
    return `$${this.cost.toFixed(4)}`;
  }

  get tpsDisplay(): string {
    if (!this.usage) return '0 tok/s';
    const tps = this.usageCalc.calcTps(this.usage);
    return `${tps} tok/s`;
  }
}
