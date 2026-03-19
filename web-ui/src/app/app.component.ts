import { Component, OnInit } from '@angular/core';
import { WorkspaceService } from './services/workspace.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  constructor(private workspaceService: WorkspaceService) {}

  ngOnInit(): void {
    this.workspaceService.init();
  }
}
