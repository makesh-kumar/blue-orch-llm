import {
  Directive,
  ElementRef,
  Input,
  AfterViewInit,
  OnChanges,
  OnDestroy,
  SimpleChanges,
} from '@angular/core';

declare const bootstrap: any;

@Directive({ selector: '[bsTooltip]' })
export class BsTooltipDirective implements AfterViewInit, OnChanges, OnDestroy {
  @Input('bsTooltip') tooltipText = '';
  @Input() tooltipPlacement: 'top' | 'bottom' | 'left' | 'right' = 'top';

  private _tooltip: any = null;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngAfterViewInit(): void {
    this._init();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this._tooltip) {
      this._tooltip.dispose();
      this._tooltip = null;
    }
    this._init();
  }

  ngOnDestroy(): void {
    if (this._tooltip) {
      this._tooltip.dispose();
      this._tooltip = null;
    }
  }

  private _init(): void {
    if (typeof bootstrap === 'undefined' || !this.tooltipText) return;
    this._tooltip = new bootstrap.Tooltip(this.el.nativeElement, {
      title: this.tooltipText,
      placement: this.tooltipPlacement,
      trigger: 'hover',
      customClass: 'bs-tooltip-sm',
      delay: { show: 1000, hide: 100 },
    });
  }
}
