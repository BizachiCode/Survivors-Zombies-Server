/**
 * Maintenance mode that an admin can flip at runtime. It starts from MAINTENANCE_MODE and is read by the auth room
 * (`isMaintenanceEnabled`) and /health; the override lives in this process only and is lost on restart.
 */
export class MaintenanceFlag {
  private enabled: boolean;

  constructor(initial: boolean) {
    this.enabled = initial;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  set(value: boolean): void {
    this.enabled = value;
  }
}
