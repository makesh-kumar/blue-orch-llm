import { Component, Input } from '@angular/core';
import { UsageCalculatorService } from '../../services/usage-calculator.service';

@Component({
  selector: 'app-token-badge',
  templateUrl: './token-badge.component.html',
  styleUrls: ['./token-badge.component.scss'],
})
export class TokenBadgeComponent {
  @Input() usage: any = null;
  @Input() cost: number = 0;

  constructor(private usageCalc: UsageCalculatorService) {
    console.log(`[INIT] ${new Date().toISOString()} TokenBadgeComponent initialized`);
  }

  get inputDisplay(): string {
    return this.usageCalc.formatTokens(this.usage?.promptTokenCount ?? 0);
  }

  get outputDisplay(): string {
    return this.usageCalc.formatTokens(this.usage?.candidatesTokenCount ?? 0);
  }

  get cachedDisplay(): string {
    return this.usageCalc.formatTokens(this.usage?.cachedContentTokenCount ?? 0);
  }

  get costDisplay(): string {
    return `$${this.cost.toFixed(4)}`;
  }

  get hasCached(): boolean {
    return (this.usage?.cachedContentTokenCount ?? 0) > 0;
  }
}
